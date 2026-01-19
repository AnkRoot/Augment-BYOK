"use strict";

const { joinBaseUrl } = require("./http");
const { parseSse } = require("./sse");
const { normalizeString, requireString, normalizeRawToken, stripByokInternalKeys } = require("../infra/util");
const { withJsonContentType, openAiAuthHeaders } = require("./headers");
const { normalizeUsageInt, makeToolMetaGetter, assertSseResponse } = require("./provider-util");
const { fetchOkWithRetry, extractErrorMessageFromJson } = require("./request-util");
const {
  STOP_REASON_END_TURN,
  STOP_REASON_TOOL_USE_REQUESTED,
  mapOpenAiFinishReasonToAugment,
  rawResponseNode,
  toolUseStartNode,
  toolUseNode,
  thinkingNode,
  mainTextFinishedNode,
  tokenUsageNode,
  makeBackChatChunk
} = require("../core/augment-protocol");

function buildOpenAiRequest({ baseUrl, apiKey, model, messages, tools, extraHeaders, requestDefaults, stream, includeUsage }) {
  const url = joinBaseUrl(requireString(baseUrl, "OpenAI baseUrl"), "chat/completions");
  const key = normalizeRawToken(apiKey);
  const extra = extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {};
  if (!key && Object.keys(extra).length === 0) throw new Error("OpenAI apiKey 未配置（且 headers 为空）");
  const m = requireString(model, "OpenAI model");
  if (!Array.isArray(messages) || !messages.length) throw new Error("OpenAI messages 为空");
  const rd = stripByokInternalKeys(requestDefaults);
  const body = { ...rd, model: m, messages, stream: Boolean(stream) };
  if (stream && includeUsage) body.stream_options = { include_usage: true };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const headers = withJsonContentType(openAiAuthHeaders(key, extraHeaders));
  if (stream) headers.accept = "text/event-stream";
  return { url, headers, body };
}

async function openAiCompleteText({ baseUrl, apiKey, model, messages, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const { url, headers, body } = buildOpenAiRequest({ baseUrl, apiKey, model, messages, tools: [], extraHeaders, requestDefaults, stream: false, includeUsage: false });
  const resp = await fetchOkWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: "OpenAI" });
  const json = await resp.json().catch(() => null);
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("OpenAI 响应缺少 choices[0].message.content");
  return text;
}

async function* openAiStreamTextDeltas({ baseUrl, apiKey, model, messages, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const { url, headers, body } = buildOpenAiRequest({ baseUrl, apiKey, model, messages, tools: [], extraHeaders, requestDefaults, stream: true, includeUsage: false });
  const resp = await fetchOkWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: "OpenAI(stream)" });
  await assertSseResponse(resp, { label: "OpenAI(stream)", expectedHint: "请确认 baseUrl 指向 OpenAI /chat/completions" });
  let dataEvents = 0;
  let parsedChunks = 0;
  let emitted = 0;
  for await (const ev of parseSse(resp)) {
    const data = normalizeString(ev?.data);
    if (!data) continue;
    dataEvents += 1;
    if (data === "[DONE]") break;
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    parsedChunks += 1;
    if (json && typeof json === "object" && json.error) {
      const msg = normalizeString(extractErrorMessageFromJson(json)) || "upstream error";
      throw new Error(`OpenAI(stream) upstream error: ${msg}`.trim());
    }
    const delta = json?.choices?.[0]?.delta;
    const text = typeof delta?.content === "string" ? delta.content : "";
    if (text) { emitted += 1; yield text; }
  }
  if (emitted === 0) throw new Error(`OpenAI(stream) 未解析到任何 SSE delta（data_events=${dataEvents}, parsed_chunks=${parsedChunks}）；请检查 baseUrl 是否为 OpenAI SSE`.trim());
}

function normalizeToolCallIndex(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function ensureToolCallRecord(toolCallsByIndex, index) {
  const idx = normalizeToolCallIndex(index);
  if (!toolCallsByIndex.has(idx)) toolCallsByIndex.set(idx, { id: "", name: "", args: "" });
  return toolCallsByIndex.get(idx);
}

async function* openAiChatStreamChunks({ baseUrl, apiKey, model, messages, tools, timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart }) {
  const { url, headers, body } = buildOpenAiRequest({ baseUrl, apiKey, model, messages, tools, extraHeaders, requestDefaults, stream: true, includeUsage: true });
  const resp = await fetchOkWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: "OpenAI(chat-stream)" });
  await assertSseResponse(resp, { label: "OpenAI(chat-stream)", expectedHint: "请确认 baseUrl 指向 OpenAI /chat/completions SSE" });

  const getToolMeta = makeToolMetaGetter(toolMetaByName);

  const toolCallsByIndex = new Map();
  let nodeId = 0;
  let fullText = "";
  let thinkingBuf = "";
  let sawToolUse = false;
  let stopReason = null;
  let stopReasonSeen = false;
  let usagePromptTokens = null;
  let usageCompletionTokens = null;
  let usageCacheReadInputTokens = null;
  let usageCacheCreationInputTokens = null;
  let dataEvents = 0;
  let parsedChunks = 0;
  let emittedChunks = 0;

  for await (const ev of parseSse(resp)) {
    const data = normalizeString(ev?.data);
    if (!data) continue;
    dataEvents += 1;
    if (data === "[DONE]") break;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    parsedChunks += 1;
    if (json && typeof json === "object" && json.error) {
      const msg = normalizeString(extractErrorMessageFromJson(json)) || "upstream error";
      throw new Error(`OpenAI(chat-stream) upstream error: ${msg}`.trim());
    }

    const u = json && typeof json === "object" && json.usage && typeof json.usage === "object" ? json.usage : null;
    if (u) {
      const pt = normalizeUsageInt(u.prompt_tokens);
      const ct = normalizeUsageInt(u.completion_tokens);
      if (pt != null) usagePromptTokens = pt;
      if (ct != null) usageCompletionTokens = ct;

      const ptd = u.prompt_tokens_details && typeof u.prompt_tokens_details === "object" ? u.prompt_tokens_details : null;
      if (ptd) {
        const cached = normalizeUsageInt(ptd.cached_tokens ?? ptd.cache_read_input_tokens ?? ptd.cache_read_tokens);
        const created = normalizeUsageInt(ptd.cache_creation_tokens ?? ptd.cache_creation_input_tokens);
        if (cached != null) usageCacheReadInputTokens = cached;
        if (created != null) usageCacheCreationInputTokens = created;
      }
    }

    const choices = Array.isArray(json?.choices) ? json.choices : [];
    for (const c of choices) {
      const delta = c && typeof c === "object" ? c.delta : null;
      const text = typeof delta?.content === "string" ? delta.content : "";
      if (text) {
        fullText += text;
        nodeId += 1;
        emittedChunks += 1;
        yield makeBackChatChunk({ text, nodes: [rawResponseNode({ id: nodeId, content: text })] });
      }

      const thinking =
        (typeof delta?.reasoning === "string" && delta.reasoning) ||
        (typeof delta?.reasoning_content === "string" && delta.reasoning_content) ||
        (typeof delta?.thinking === "string" && delta.thinking) ||
        (typeof delta?.thinking_content === "string" && delta.thinking_content) ||
        "";
      if (thinking) thinkingBuf += thinking;

      const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : null;
      if (toolCalls) {
        for (const tc of toolCalls) {
          const rec = ensureToolCallRecord(toolCallsByIndex, tc?.index);
          if (typeof tc?.id === "string" && tc.id.trim()) rec.id = tc.id.trim();
          const fn = tc?.function && typeof tc.function === "object" ? tc.function : null;
          if (fn && typeof fn.name === "string" && fn.name.trim()) rec.name = fn.name.trim();
          if (fn && typeof fn.arguments === "string" && fn.arguments) rec.args += fn.arguments;
        }
      }

      const fc = delta?.function_call && typeof delta.function_call === "object" ? delta.function_call : null;
      if (fc) {
        const rec = ensureToolCallRecord(toolCallsByIndex, 0);
        if (typeof fc.name === "string" && fc.name.trim()) rec.name = fc.name.trim();
        if (typeof fc.arguments === "string" && fc.arguments) rec.args += fc.arguments;
      }

      if (typeof c?.finish_reason === "string" && c.finish_reason.trim()) {
        stopReasonSeen = true;
        stopReason = mapOpenAiFinishReasonToAugment(c.finish_reason.trim());
      }
    }
  }

  const ordered = Array.from(toolCallsByIndex.entries()).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const hasUsage = usagePromptTokens != null || usageCompletionTokens != null || usageCacheReadInputTokens != null || usageCacheCreationInputTokens != null;
  const hasToolCalls = ordered.some((tc) => normalizeString(tc?.name));
  const thinkingSummary = normalizeString(thinkingBuf);
  if (emittedChunks === 0 && !hasUsage && !hasToolCalls && !thinkingSummary) {
    throw new Error(`OpenAI(chat-stream) 未解析到任何上游 SSE 内容（data_events=${dataEvents}, parsed_chunks=${parsedChunks}）；请检查 baseUrl 是否为 OpenAI /chat/completions SSE`);
  }

  if (thinkingSummary) {
    nodeId += 1;
    yield makeBackChatChunk({ text: "", nodes: [thinkingNode({ id: nodeId, summary: thinkingSummary })] });
  }

  for (let i = 0; i < ordered.length; i++) {
    const tc = ordered[i];
    const toolName = normalizeString(tc?.name);
    if (!toolName) continue;
    let toolUseId = normalizeString(tc?.id);
    if (!toolUseId) toolUseId = `tool-${nodeId + 1}`;
    const inputJson = normalizeString(tc?.args) || "{}";
    const meta = getToolMeta(toolName);
    sawToolUse = true;
    if (supportToolUseStart === true) {
      nodeId += 1;
      yield makeBackChatChunk({ text: "", nodes: [toolUseStartNode({ id: nodeId, toolUseId, toolName, inputJson, mcpServerName: meta.mcpServerName, mcpToolName: meta.mcpToolName })] });
    }
    nodeId += 1;
    yield makeBackChatChunk({ text: "", nodes: [toolUseNode({ id: nodeId, toolUseId, toolName, inputJson, mcpServerName: meta.mcpServerName, mcpToolName: meta.mcpToolName })] });
  }
  if (hasUsage) {
    nodeId += 1;
    yield makeBackChatChunk({
      text: "",
      nodes: [
        tokenUsageNode({
          id: nodeId,
          inputTokens: usagePromptTokens,
          outputTokens: usageCompletionTokens,
          cacheReadInputTokens: usageCacheReadInputTokens,
          cacheCreationInputTokens: usageCacheCreationInputTokens
        })
      ]
    });
  }

  const finalNodes = [];
  if (fullText) {
    nodeId += 1;
    finalNodes.push(mainTextFinishedNode({ id: nodeId, content: fullText }));
  }

  const stop_reason = stopReasonSeen && stopReason != null ? stopReason : sawToolUse ? STOP_REASON_TOOL_USE_REQUESTED : STOP_REASON_END_TURN;
  yield makeBackChatChunk({ text: "", nodes: finalNodes, stop_reason });
}

module.exports = { openAiCompleteText, openAiStreamTextDeltas, openAiChatStreamChunks };
