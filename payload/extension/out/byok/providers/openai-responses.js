"use strict";

const { joinBaseUrl } = require("./http");
const { parseSse } = require("./sse");
const { normalizeString, requireString, normalizeRawToken, stripByokInternalKeys } = require("../infra/util");
const { withJsonContentType, openAiAuthHeaders } = require("./headers");
const { normalizeUsageInt, makeToolMetaGetter, assertSseResponse } = require("./provider-util");
const { fetchOkWithRetry, extractErrorMessageFromJson } = require("./request-util");
const {
  STOP_REASON_END_TURN,
  STOP_REASON_MAX_TOKENS,
  STOP_REASON_TOOL_USE_REQUESTED,
  rawResponseNode,
  toolUseStartNode,
  toolUseNode,
  thinkingNode,
  tokenUsageNode,
  mainTextFinishedNode,
  makeBackChatChunk
} = require("../core/augment-protocol");

function buildOpenAiResponsesRequest({ baseUrl, apiKey, model, instructions, input, tools, extraHeaders, requestDefaults, stream }) {
  const url = joinBaseUrl(requireString(baseUrl, "OpenAI baseUrl"), "responses");
  const key = normalizeRawToken(apiKey);
  const extra = extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {};
  if (!key && Object.keys(extra).length === 0) throw new Error("OpenAI apiKey 未配置（且 headers 为空）");

  const m = requireString(model, "OpenAI model");
  const rd = stripByokInternalKeys(requestDefaults);
  const body = { ...rd, model: m, input, stream: Boolean(stream) };
  const ins = normalizeString(instructions);
  if (ins) body.instructions = ins.trim();
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    if (body.tool_choice == null) body.tool_choice = "auto";
  }

  const headers = withJsonContentType(openAiAuthHeaders(key, extraHeaders));
  if (stream) headers.accept = "text/event-stream";
  return { url, headers, body };
}

async function openAiResponsesCompleteText({ baseUrl, apiKey, model, instructions, input, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const { url, headers, body } = buildOpenAiResponsesRequest({ baseUrl, apiKey, model, instructions, input, tools: [], extraHeaders, requestDefaults, stream: false });
  const resp = await fetchOkWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: "OpenAI(responses)" });

  const json = await resp.json().catch(() => null);
  const direct = normalizeString(json?.output_text ?? json?.outputText ?? json?.text);
  if (direct) return direct;

  const output = Array.isArray(json?.output) ? json.output : [];
  const parts = [];
  for (const it of output) {
    if (!it || typeof it !== "object") continue;
    if (it.type === "message" && it.role === "assistant") {
      const content = it.content;
      if (typeof content === "string" && content.trim()) {
        parts.push(content);
        continue;
      }
      const blocks = Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        if ((b.type === "output_text" || b.type === "text") && typeof b.text === "string" && b.text) parts.push(b.text);
      }
      continue;
    }
    if ((it.type === "output_text" || it.type === "text") && typeof it.text === "string" && it.text) {
      parts.push(it.text);
      continue;
    }
  }
  const joined = parts.join("").trim();
  if (joined) return joined;

  const hasToolCall = output.some((it) => it && typeof it === "object" && it.type === "function_call");
  if (hasToolCall) throw new Error("OpenAI(responses) 返回 function_call（当前调用不执行工具；请改用 /chat-stream）");

  // 兼容：部分 /responses 网关只支持 SSE（即使 stream=false 也可能返回非 JSON/空 JSON）。
  // 这里做一次“流式兜底”以提升 openai_responses provider 的鲁棒性。
  try {
    let out = "";
    for await (const d of openAiResponsesStreamTextDeltas({ baseUrl, apiKey, model, instructions, input, timeoutMs, abortSignal, extraHeaders, requestDefaults })) {
      if (typeof d === "string") out += d;
    }
    const s = normalizeString(out);
    if (s) return s;
  } catch (err) {
    const fallbackMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenAI(responses) 响应缺少可解析文本（且 stream fallback 失败: ${fallbackMsg}）`.trim());
  }

  const types = output
    .map((it) => (it && typeof it === "object" ? normalizeString(it.type) || "unknown" : "unknown"))
    .filter(Boolean)
    .slice(0, 12)
    .join(",");
  throw new Error(`OpenAI(responses) 响应缺少可解析文本（output_types=${types || "n/a"}）`.trim());
}

async function* openAiResponsesStreamTextDeltas({ baseUrl, apiKey, model, instructions, input, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const { url, headers, body } = buildOpenAiResponsesRequest({ baseUrl, apiKey, model, instructions, input, tools: [], extraHeaders, requestDefaults, stream: true });
  const resp = await fetchOkWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: "OpenAI(responses-stream)" });
  await assertSseResponse(resp, { label: "OpenAI(responses-stream)", expectedHint: "请确认 baseUrl 指向 OpenAI /responses SSE" });

  let dataEvents = 0;
  let parsedChunks = 0;
  let emitted = 0;
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
    const eventType = normalizeString(json?.type) || normalizeString(ev?.event);
    if (eventType === "response.output_text.delta" && typeof json?.delta === "string" && json.delta) {
      emitted += 1;
      yield json.delta;
    } else if (eventType === "response.error") {
      const msg = normalizeString(extractErrorMessageFromJson(json)) || "upstream error event";
      throw new Error(`OpenAI(responses-stream) upstream error event: ${msg}`.trim());
    }
  }
  if (emitted === 0) throw new Error(`OpenAI(responses-stream) 未解析到任何 SSE delta（data_events=${dataEvents}, parsed_chunks=${parsedChunks}）；请检查 baseUrl 是否为 OpenAI SSE`.trim());
}

function extractToolCallsFromResponseOutput(output) {
  const list = Array.isArray(output) ? output : [];
  const out = [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    if (it.type !== "function_call") continue;
    const call_id = normalizeString(it.call_id);
    const name = normalizeString(it.name);
    const args = typeof it.arguments === "string" ? it.arguments : "";
    if (!call_id || !name) continue;
    out.push({ call_id, name, arguments: normalizeString(args) || "{}" });
  }
  return out;
}

function extractReasoningSummaryFromResponseOutput(output) {
  const list = Array.isArray(output) ? output : [];
  const parts = [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    if (it.type !== "reasoning") continue;
    const summary = Array.isArray(it.summary) ? it.summary : [];
    for (const s of summary) {
      if (!s || typeof s !== "object") continue;
      if (s.type !== "summary_text") continue;
      const text = normalizeString(s.text);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

async function* openAiResponsesChatStreamChunks({ baseUrl, apiKey, model, instructions, input, tools, timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart }) {
  const getToolMeta = makeToolMetaGetter(toolMetaByName);

  const { url, headers, body } = buildOpenAiResponsesRequest({ baseUrl, apiKey, model, instructions, input, tools, extraHeaders, requestDefaults, stream: true });
  const resp = await fetchOkWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: "OpenAI(responses-chat-stream)" });
  await assertSseResponse(resp, { label: "OpenAI(responses-chat-stream)", expectedHint: "请确认 baseUrl 指向 OpenAI /responses SSE" });

  let nodeId = 0;
  let fullText = "";
  let sawToolUse = false;
  let sawMaxTokens = false;
  let usageInputTokens = null;
  let usageOutputTokens = null;
  let usageCacheReadInputTokens = null;
  let thinkingBuf = "";
  let dataEvents = 0;
  let parsedChunks = 0;
  let emittedChunks = 0;
  let finalResponse = null;
  const toolCallsByOutputIndex = new Map(); // output_index -> {call_id,name,arguments}

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

    const eventType = normalizeString(json?.type) || normalizeString(ev?.event);
    if (!eventType) continue;

    if (eventType === "response.output_item.added") {
      const item = json?.item && typeof json.item === "object" ? json.item : null;
      const outputIndex = Number(json?.output_index);
      if (item && item.type === "function_call" && Number.isFinite(outputIndex) && outputIndex >= 0) {
        const call_id = normalizeString(item.call_id);
        const name = normalizeString(item.name);
        const args = typeof item.arguments === "string" ? item.arguments : "";
        if (call_id && name) toolCallsByOutputIndex.set(Math.floor(outputIndex), { call_id, name, arguments: normalizeString(args) || "" });
      }
      continue;
    }

    if (eventType === "response.function_call_arguments.delta") {
      const outputIndex = Number(json?.output_index);
      const delta = typeof json?.delta === "string" ? json.delta : "";
      if (delta && Number.isFinite(outputIndex)) {
        const rec = toolCallsByOutputIndex.get(Math.floor(outputIndex));
        if (rec) rec.arguments += delta;
      }
      continue;
    }

    if (eventType === "response.function_call_arguments.done") {
      const outputIndex = Number(json?.output_index);
      const args = typeof json?.arguments === "string" ? json.arguments : "";
      if (Number.isFinite(outputIndex) && args) {
        const rec = toolCallsByOutputIndex.get(Math.floor(outputIndex));
        if (rec) rec.arguments = args;
      }
      continue;
    }

    if (eventType === "response.output_text.delta" && typeof json?.delta === "string" && json.delta) {
      const t = json.delta;
      fullText += t;
      nodeId += 1;
      emittedChunks += 1;
      yield makeBackChatChunk({ text: t, nodes: [rawResponseNode({ id: nodeId, content: t })] });
      continue;
    }

    if (eventType === "response.reasoning_summary_part.added" || eventType === "response.reasoning_summary_text.done") {
      const partText = normalizeString(json?.part?.text ?? json?.text);
      if (partText) thinkingBuf += (thinkingBuf ? "\n" : "") + partText;
      continue;
    }

    if (eventType === "response.reasoning_text.delta" && typeof json?.delta === "string" && json.delta) {
      thinkingBuf += json.delta;
      continue;
    }

    if (eventType === "response.incomplete") {
      sawMaxTokens = true;
      continue;
    }

    if (eventType === "response.completed" && json?.response && typeof json.response === "object") {
      finalResponse = json.response;
      const usage = json.response?.usage && typeof json.response.usage === "object" ? json.response.usage : null;
      if (usage) {
        const it = normalizeUsageInt(usage.input_tokens);
        const ot = normalizeUsageInt(usage.output_tokens);
        const cached = normalizeUsageInt(usage?.input_tokens_details?.cached_tokens);
        if (it != null) usageInputTokens = it;
        if (ot != null) usageOutputTokens = ot;
        if (cached != null) usageCacheReadInputTokens = cached;
      }
      continue;
    }

    if (eventType === "response.error") {
      const msg = normalizeString(extractErrorMessageFromJson(json)) || "upstream error event";
      throw new Error(`OpenAI(responses-chat-stream) upstream error event: ${msg}`.trim());
    }
  }

  let toolCalls = [];
  let reasoningSummary = "";
  if (finalResponse && typeof finalResponse === "object") {
    const out = Array.isArray(finalResponse.output) ? finalResponse.output : [];
    toolCalls = extractToolCallsFromResponseOutput(out);
    reasoningSummary = extractReasoningSummaryFromResponseOutput(out);
    const u = finalResponse?.usage && typeof finalResponse.usage === "object" ? finalResponse.usage : null;
    if (u) {
      const it = normalizeUsageInt(u.input_tokens);
      const ot = normalizeUsageInt(u.output_tokens);
      const cached = normalizeUsageInt(u?.input_tokens_details?.cached_tokens);
      if (it != null) usageInputTokens = it;
      if (ot != null) usageOutputTokens = ot;
      if (cached != null) usageCacheReadInputTokens = cached;
    }
    if (!fullText) fullText = normalizeString(finalResponse.output_text);
  } else {
    toolCalls = Array.from(toolCallsByOutputIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map((x) => x[1])
      .filter((tc) => tc && typeof tc === "object");
  }

  if (reasoningSummary) thinkingBuf = reasoningSummary;

  if (thinkingBuf) {
    nodeId += 1;
    yield makeBackChatChunk({ text: "", nodes: [thinkingNode({ id: nodeId, summary: thinkingBuf })] });
  }

  for (const tc of toolCalls) {
    const toolName = normalizeString(tc?.name);
    if (!toolName) continue;
    let toolUseId = normalizeString(tc?.call_id);
    if (!toolUseId) toolUseId = `call_${nodeId + 1}`;
    const inputJson = normalizeString(tc?.arguments) || "{}";
    const meta = getToolMeta(toolName);
    sawToolUse = true;
    if (supportToolUseStart === true) {
      nodeId += 1;
      yield makeBackChatChunk({ text: "", nodes: [toolUseStartNode({ id: nodeId, toolUseId, toolName, inputJson, mcpServerName: meta.mcpServerName, mcpToolName: meta.mcpToolName })] });
    }
    nodeId += 1;
    yield makeBackChatChunk({ text: "", nodes: [toolUseNode({ id: nodeId, toolUseId, toolName, inputJson, mcpServerName: meta.mcpServerName, mcpToolName: meta.mcpToolName })] });
  }

  const hasUsage = usageInputTokens != null || usageOutputTokens != null || usageCacheReadInputTokens != null;
  if (hasUsage) {
    nodeId += 1;
    yield makeBackChatChunk({ text: "", nodes: [tokenUsageNode({ id: nodeId, inputTokens: usageInputTokens, outputTokens: usageOutputTokens, cacheReadInputTokens: usageCacheReadInputTokens })] });
  }

  const finalNodes = [];
  if (fullText) {
    nodeId += 1;
    finalNodes.push(mainTextFinishedNode({ id: nodeId, content: fullText }));
  }

  const stop_reason = sawMaxTokens ? STOP_REASON_MAX_TOKENS : sawToolUse ? STOP_REASON_TOOL_USE_REQUESTED : STOP_REASON_END_TURN;
  yield makeBackChatChunk({ text: "", nodes: finalNodes, stop_reason });

  const emittedAny = emittedChunks > 0 || hasUsage || toolCalls.length > 0 || Boolean(thinkingBuf);
  if (!emittedAny) {
    throw new Error(`OpenAI(responses-chat-stream) 未解析到任何上游 SSE 内容（data_events=${dataEvents}, parsed_chunks=${parsedChunks}）；请检查 baseUrl 是否为 OpenAI /responses SSE`);
  }
}

module.exports = { openAiResponsesCompleteText, openAiResponsesStreamTextDeltas, openAiResponsesChatStreamChunks };
