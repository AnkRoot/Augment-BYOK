"use strict";

const { joinBaseUrl, safeFetch, readTextLimit } = require("./http");
const { parseSse } = require("./sse");
const { normalizeString, requireString } = require("../infra/util");
const { withJsonContentType, openAiAuthHeaders } = require("./headers");
const {
  STOP_REASON_END_TURN,
  STOP_REASON_TOOL_USE_REQUESTED,
  mapOpenAiFinishReasonToAugment,
  rawResponseNode,
  toolUseStartNode,
  toolUseNode,
  mainTextFinishedNode,
  tokenUsageNode,
  makeBackChatChunk
} = require("../core/augment-protocol");

function buildOpenAiRequest({ baseUrl, apiKey, model, messages, extraHeaders, requestDefaults, stream }) {
  const url = joinBaseUrl(requireString(baseUrl, "OpenAI baseUrl"), "chat/completions");
  const key = requireString(apiKey, "OpenAI apiKey");
  const m = requireString(model, "OpenAI model");
  if (!Array.isArray(messages) || !messages.length) throw new Error("OpenAI messages 为空");
  const body = { ...(requestDefaults && typeof requestDefaults === "object" ? requestDefaults : null), model: m, messages, stream: Boolean(stream) };
  const headers = withJsonContentType(openAiAuthHeaders(key, extraHeaders));
  return { url, headers, body };
}

async function openAiCompleteText({ baseUrl, apiKey, model, messages, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const { url, headers, body } = buildOpenAiRequest({ baseUrl, apiKey, model, messages, extraHeaders, requestDefaults, stream: false });
  const resp = await safeFetch(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    },
    { timeoutMs, abortSignal, label: "OpenAI" }
  );

  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await readTextLimit(resp, 500)}`.trim());
  const json = await resp.json().catch(() => null);
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("OpenAI 响应缺少 choices[0].message.content");
  return text;
}

async function* openAiStreamTextDeltas({ baseUrl, apiKey, model, messages, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const { url, headers, body } = buildOpenAiRequest({ baseUrl, apiKey, model, messages, extraHeaders, requestDefaults, stream: true });
  const resp = await safeFetch(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    },
    { timeoutMs, abortSignal, label: "OpenAI(stream)" }
  );

  if (!resp.ok) throw new Error(`OpenAI(stream) ${resp.status}: ${await readTextLimit(resp, 500)}`.trim());
  for await (const ev of parseSse(resp)) {
    const data = normalizeString(ev?.data);
    if (!data) continue;
    if (data === "[DONE]") break;
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    const delta = json?.choices?.[0]?.delta;
    const text = typeof delta?.content === "string" ? delta.content : "";
    if (text) yield text;
  }
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

function buildOpenAiChatStreamRequest({ baseUrl, apiKey, model, messages, tools, extraHeaders, requestDefaults }) {
  const url = joinBaseUrl(requireString(baseUrl, "OpenAI baseUrl"), "chat/completions");
  const key = requireString(apiKey, "OpenAI apiKey");
  const m = requireString(model, "OpenAI model");
  if (!Array.isArray(messages) || !messages.length) throw new Error("OpenAI messages 为空");
  const body = { ...(requestDefaults && typeof requestDefaults === "object" ? requestDefaults : null), model: m, messages, stream: true, stream_options: { include_usage: true } };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const headers = withJsonContentType(openAiAuthHeaders(key, extraHeaders));
  return { url, headers, body };
}

async function* openAiChatStreamChunks({ baseUrl, apiKey, model, messages, tools, timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart }) {
  const { url, headers, body } = buildOpenAiChatStreamRequest({ baseUrl, apiKey, model, messages, tools, extraHeaders, requestDefaults });
  const resp = await safeFetch(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: "OpenAI(chat-stream)" });
  if (!resp.ok) throw new Error(`OpenAI(chat-stream) ${resp.status}: ${await readTextLimit(resp, 500)}`.trim());

  const metaMap = toolMetaByName instanceof Map ? toolMetaByName : new Map();
  const getToolMeta = (toolName) => metaMap.get(toolName) || {};

  const toolCallsByIndex = new Map();
  let nodeId = 0;
  let fullText = "";
  let sawToolUse = false;
  let stopReason = null;
  let stopReasonSeen = false;
  let usagePromptTokens = null;
  let usageCompletionTokens = null;

  for await (const ev of parseSse(resp)) {
    const data = normalizeString(ev?.data);
    if (!data) continue;
    if (data === "[DONE]") break;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }

    const u = json && typeof json === "object" && json.usage && typeof json.usage === "object" ? json.usage : null;
    if (u) {
      const pt = Number(u.prompt_tokens);
      const ct = Number(u.completion_tokens);
      if (Number.isFinite(pt)) usagePromptTokens = pt;
      if (Number.isFinite(ct)) usageCompletionTokens = ct;
    }

    const choices = Array.isArray(json?.choices) ? json.choices : [];
    for (const c of choices) {
      const delta = c && typeof c === "object" ? c.delta : null;
      const text = typeof delta?.content === "string" ? delta.content : "";
      if (text) {
        fullText += text;
        nodeId += 1;
        yield makeBackChatChunk({ text, nodes: [rawResponseNode({ id: nodeId, content: text })] });
      }

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
  if (Number.isFinite(Number(usagePromptTokens)) || Number.isFinite(Number(usageCompletionTokens))) {
    nodeId += 1;
    yield makeBackChatChunk({ text: "", nodes: [tokenUsageNode({ id: nodeId, inputTokens: usagePromptTokens, outputTokens: usageCompletionTokens })] });
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
