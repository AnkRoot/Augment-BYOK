"use strict";

const { joinBaseUrl, safeFetch, readTextLimit } = require("./http");
const { parseSse } = require("./sse");
const { normalizeString, requireString } = require("../infra/util");
const { withJsonContentType, anthropicAuthHeaders } = require("./headers");
const {
  STOP_REASON_END_TURN,
  STOP_REASON_TOOL_USE_REQUESTED,
  mapAnthropicStopReasonToAugment,
  rawResponseNode,
  toolUseStartNode,
  toolUseNode,
  thinkingNode,
  tokenUsageNode,
  mainTextFinishedNode,
  makeBackChatChunk
} = require("../core/augment-protocol");

function pickMaxTokens(requestDefaults) {
  const v = requestDefaults && typeof requestDefaults === "object" ? requestDefaults.max_tokens ?? requestDefaults.maxTokens : undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 1024;
}

function buildAnthropicRequest({ baseUrl, apiKey, model, system, messages, tools, extraHeaders, requestDefaults, stream }) {
  const url = joinBaseUrl(requireString(baseUrl, "Anthropic baseUrl"), "messages");
  const key = requireString(apiKey, "Anthropic apiKey");
  const m = requireString(model, "Anthropic model");
  if (!Array.isArray(messages) || !messages.length) throw new Error("Anthropic messages 为空");

  const body = {
    ...(requestDefaults && typeof requestDefaults === "object" ? requestDefaults : null),
    model: m,
    max_tokens: pickMaxTokens(requestDefaults),
    messages,
    stream: Boolean(stream)
  };
  if (typeof system === "string" && system.trim()) body.system = system.trim();
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = { type: "auto" };
  }
  const headers = withJsonContentType(anthropicAuthHeaders(key, extraHeaders));
  return { url, headers, body };
}

async function anthropicCompleteText({ baseUrl, apiKey, model, system, messages, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const { url, headers, body } = buildAnthropicRequest({ baseUrl, apiKey, model, system, messages, tools: [], extraHeaders, requestDefaults, stream: false });

  const resp = await safeFetch(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    },
    { timeoutMs, abortSignal, label: "Anthropic" }
  );

  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await readTextLimit(resp, 500)}`.trim());
  const json = await resp.json().catch(() => null);
  const blocks = Array.isArray(json?.content) ? json.content : [];
  const out = blocks.map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
  if (!out) throw new Error("Anthropic 响应缺少 content[].text");
  return out;
}

async function* anthropicStreamTextDeltas({ baseUrl, apiKey, model, system, messages, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const { url, headers, body } = buildAnthropicRequest({ baseUrl, apiKey, model, system, messages, tools: [], extraHeaders, requestDefaults, stream: true });

  const resp = await safeFetch(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    },
    { timeoutMs, abortSignal, label: "Anthropic(stream)" }
  );

  if (!resp.ok) throw new Error(`Anthropic(stream) ${resp.status}: ${await readTextLimit(resp, 500)}`.trim());
  for await (const ev of parseSse(resp)) {
    const data = normalizeString(ev?.data);
    if (!data) continue;
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    if (json?.type === "message_stop") break;
    if (json?.type === "content_block_delta" && json.delta && json.delta.type === "text_delta" && typeof json.delta.text === "string") {
      const t = json.delta.text;
      if (t) yield t;
    }
  }
}

function normalizeUsageInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function* anthropicChatStreamChunks({ baseUrl, apiKey, model, system, messages, tools, timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart }) {
  const { url, headers, body } = buildAnthropicRequest({ baseUrl, apiKey, model, system, messages, tools, extraHeaders, requestDefaults, stream: true });
  const resp = await safeFetch(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: "Anthropic(chat-stream)" });
  if (!resp.ok) throw new Error(`Anthropic(chat-stream) ${resp.status}: ${await readTextLimit(resp, 500)}`.trim());

  const metaMap = toolMetaByName instanceof Map ? toolMetaByName : new Map();
  const getToolMeta = (toolName) => metaMap.get(toolName) || {};

  let nodeId = 0;
  let fullText = "";
  let stopReason = null;
  let stopReasonSeen = false;
  let sawToolUse = false;
  let usageInputTokens = null;
  let usageOutputTokens = null;
  let usageCacheReadInputTokens = null;
  let usageCacheCreationInputTokens = null;
  let currentBlockType = "";
  let toolUseId = "";
  let toolName = "";
  let toolInputJson = "";
  let thinkingBuf = "";

  for await (const ev of parseSse(resp)) {
    const data = normalizeString(ev?.data);
    if (!data) continue;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    const eventType = normalizeString(json?.type) || normalizeString(ev?.event);

    const usage = (json?.message && typeof json.message === "object" ? json.message.usage : null) || json?.usage;
    if (usage && typeof usage === "object") {
      const it = normalizeUsageInt(usage.input_tokens);
      const ot = normalizeUsageInt(usage.output_tokens);
      const cr = normalizeUsageInt(usage.cache_read_input_tokens);
      const cc = normalizeUsageInt(usage.cache_creation_input_tokens);
      if (it != null) usageInputTokens = it;
      if (ot != null) usageOutputTokens = ot;
      if (cr != null) usageCacheReadInputTokens = cr;
      if (cc != null) usageCacheCreationInputTokens = cc;
    }

    if (eventType === "content_block_start") {
      const block = json?.content_block && typeof json.content_block === "object" ? json.content_block : null;
      currentBlockType = normalizeString(block?.type);
      if (currentBlockType === "tool_use") {
        toolUseId = normalizeString(block?.id);
        toolName = normalizeString(block?.name);
        toolInputJson = "";
      } else if (currentBlockType === "thinking") {
        thinkingBuf = "";
      }
      continue;
    }

    if (eventType === "content_block_delta") {
      const delta = json?.delta && typeof json.delta === "object" ? json.delta : null;
      const dt = normalizeString(delta?.type);
      if (dt === "text_delta" && typeof delta?.text === "string" && delta.text) {
        const t = delta.text;
        fullText += t;
        nodeId += 1;
        yield makeBackChatChunk({ text: t, nodes: [rawResponseNode({ id: nodeId, content: t })] });
      } else if (dt === "input_json_delta" && typeof delta?.partial_json === "string" && delta.partial_json) {
        toolInputJson += delta.partial_json;
      } else if (dt === "thinking_delta" && typeof delta?.thinking === "string" && delta.thinking) {
        thinkingBuf += delta.thinking;
      }
      continue;
    }

    if (eventType === "content_block_stop") {
      if (currentBlockType === "thinking") {
        const summary = normalizeString(thinkingBuf);
        if (summary) {
          nodeId += 1;
          yield makeBackChatChunk({ text: "", nodes: [thinkingNode({ id: nodeId, summary })] });
        }
        thinkingBuf = "";
      }
      if (currentBlockType === "tool_use") {
        const name = normalizeString(toolName);
        let id = normalizeString(toolUseId);
        if (name) {
          if (!id) id = `tool-${nodeId + 1}`;
          const inputJson = normalizeString(toolInputJson) || "{}";
          const meta = getToolMeta(name);
          sawToolUse = true;
          if (supportToolUseStart === true) {
            nodeId += 1;
            yield makeBackChatChunk({ text: "", nodes: [toolUseStartNode({ id: nodeId, toolUseId: id, toolName: name, inputJson, mcpServerName: meta.mcpServerName, mcpToolName: meta.mcpToolName })] });
          }
          nodeId += 1;
          yield makeBackChatChunk({ text: "", nodes: [toolUseNode({ id: nodeId, toolUseId: id, toolName: name, inputJson, mcpServerName: meta.mcpServerName, mcpToolName: meta.mcpToolName })] });
        }
        toolUseId = "";
        toolName = "";
        toolInputJson = "";
      }
      currentBlockType = "";
      continue;
    }

    if (eventType === "message_delta") {
      const delta = json?.delta && typeof json.delta === "object" ? json.delta : null;
      const sr = normalizeString(delta?.stop_reason);
      if (sr) {
        stopReasonSeen = true;
        stopReason = mapAnthropicStopReasonToAugment(sr);
      }
      continue;
    }

    if (eventType === "message_stop") break;
    if (eventType === "error") {
      yield makeBackChatChunk({ text: "❌ 上游返回 error event", stop_reason: STOP_REASON_END_TURN });
      return;
    }
  }

  if (currentBlockType === "thinking") {
    const summary = normalizeString(thinkingBuf);
    if (summary) {
      nodeId += 1;
      yield makeBackChatChunk({ text: "", nodes: [thinkingNode({ id: nodeId, summary })] });
    }
  }

  if (Number.isFinite(Number(usageInputTokens)) || Number.isFinite(Number(usageOutputTokens)) || Number.isFinite(Number(usageCacheReadInputTokens)) || Number.isFinite(Number(usageCacheCreationInputTokens))) {
    nodeId += 1;
    yield makeBackChatChunk({ text: "", nodes: [tokenUsageNode({ id: nodeId, inputTokens: usageInputTokens, outputTokens: usageOutputTokens, cacheReadInputTokens: usageCacheReadInputTokens, cacheCreationInputTokens: usageCacheCreationInputTokens })] });
  }

  const finalNodes = [];
  if (fullText) {
    nodeId += 1;
    finalNodes.push(mainTextFinishedNode({ id: nodeId, content: fullText }));
  }

  const stop_reason = stopReasonSeen && stopReason != null ? stopReason : sawToolUse ? STOP_REASON_TOOL_USE_REQUESTED : STOP_REASON_END_TURN;
  yield makeBackChatChunk({ text: "", nodes: finalNodes, stop_reason });
}

module.exports = { anthropicCompleteText, anthropicStreamTextDeltas, anthropicChatStreamChunks };
