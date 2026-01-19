"use strict";

const { joinBaseUrl } = require("./http");
const { parseSse } = require("./sse");
const { normalizeString, requireString, normalizeRawToken } = require("../infra/util");
const { truncateText } = require("../infra/text");
const { debug } = require("../infra/log");
const { withJsonContentType, anthropicAuthHeaders } = require("./headers");
const { normalizeUsageInt, makeToolMetaGetter, assertSseResponse } = require("./provider-util");
const { fetchWithRetry, readHttpErrorDetail, extractErrorMessageFromJson } = require("./request-util");
const { stripAnthropicToolBlocksFromMessages } = require("../core/anthropic-blocks");
const { repairAnthropicToolUsePairs } = require("../core/tool-pairing");
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

function normalizeStopSequences(v) {
  if (Array.isArray(v)) {
    const out = [];
    for (const it of v) {
      const s = String(it ?? "").trim();
      if (!s) continue;
      out.push(s);
      if (out.length >= 20) break;
    }
    return out;
  }
  if (typeof v === "string") {
    const s = v.trim();
    return s ? [s] : [];
  }
  return [];
}

const ANTHROPIC_REQUEST_DEFAULTS_OMIT_KEYS = new Set([
  "model",
  "messages",
  "system",
  "stream",
  "tools",
  "tool_choice",
  "toolChoice",
  "maxTokens",
  "max_tokens",
  "stop",
  "stopSequences",
  "stop_sequences",
  "topP",
  "topK"
]);

const ANTHROPIC_REQUEST_DEFAULTS_DROP_KEYS = new Set([
  "max_completion_tokens",
  "maxOutputTokens",
  "presence_penalty",
  "presencePenalty",
  "frequency_penalty",
  "frequencyPenalty",
  "logit_bias",
  "logitBias",
  "logprobs",
  "top_logprobs",
  "topLogprobs",
  "response_format",
  "responseFormat",
  "seed",
  "n",
  "user",
  "parallel_tool_calls",
  "parallelToolCalls",
  "stream_options",
  "streamOptions",
  "functions",
  "function_call",
  "functionCall"
]);

const ANTHROPIC_FALLBACK_STATUSES = new Set([400, 422]);

function sanitizeAnthropicRequestDefaults(requestDefaults) {
  const raw = requestDefaults && typeof requestDefaults === "object" && !Array.isArray(requestDefaults) ? requestDefaults : {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k || typeof k !== "string") continue;
    if (k.startsWith("__byok")) continue;
    if (ANTHROPIC_REQUEST_DEFAULTS_OMIT_KEYS.has(k)) continue;
    if (ANTHROPIC_REQUEST_DEFAULTS_DROP_KEYS.has(k)) continue;
    out[k] = v;
  }

  const stopSeq = normalizeStopSequences(raw.stop_sequences ?? raw.stopSequences ?? raw.stop);
  if (stopSeq.length) out.stop_sequences = stopSeq;

  if (!("top_p" in out) && "topP" in raw) {
    const n = Number(raw.topP);
    if (Number.isFinite(n)) out.top_p = n;
  }
  if (!("top_k" in out) && "topK" in raw) {
    const n = Number(raw.topK);
    if (Number.isFinite(n)) out.top_k = n;
  }

  return out;
}

function normalizeAnthropicMessagesForRequest(messages) {
  const input = Array.isArray(messages) ? messages : [];
  const normalized = [];
  for (const m of input) {
    if (!m || typeof m !== "object") continue;
    const role = normalizeString(m.role);
    if (role !== "user" && role !== "assistant") continue;
    const content = m.content;
    if (typeof content === "string") {
      if (!content.trim()) continue;
      normalized.push({ role, content });
      continue;
    }
    if (Array.isArray(content)) {
      const blocks = content.filter((b) => b && typeof b === "object");
      if (!blocks.length) continue;
      normalized.push({ role, content: blocks });
      continue;
    }
  }

  const repaired = repairAnthropicToolUsePairs(normalized);
  if (repaired?.report?.injected_missing_tool_results || repaired?.report?.converted_orphan_tool_results) {
    debug(
      `anthropic tool pairing repaired: injected_missing=${Number(repaired.report.injected_missing_tool_results) || 0} converted_orphan=${Number(repaired.report.converted_orphan_tool_results) || 0}`
    );
  }

  let out = repaired && Array.isArray(repaired.messages) ? repaired.messages : normalized;

  if (out.length && out[0].role !== "user") {
    out = [{ role: "user", content: "-" }, ...out];
    debug(`Anthropic request normalized: prepended dummy user message to satisfy messages[0].role=user`);
  }
  return out;
}

function dedupeAnthropicTools(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const out = [];
  const seen = new Set();
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const name = normalizeString(t.name);
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(t);
  }
  return out;
}

function buildAnthropicRequest({ baseUrl, apiKey, model, system, messages, tools, extraHeaders, requestDefaults, stream, includeToolChoice }) {
  const url = joinBaseUrl(requireString(baseUrl, "Anthropic baseUrl"), "messages");
  const key = normalizeRawToken(apiKey);
  const extra = extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {};
  if (!key && Object.keys(extra).length === 0) throw new Error("Anthropic apiKey 未配置（且 headers 为空）");
  const m = requireString(model, "Anthropic model");
  const maxTokens = pickMaxTokens(requestDefaults);
  const rd = sanitizeAnthropicRequestDefaults(requestDefaults);
  const ms = normalizeAnthropicMessagesForRequest(messages);
  if (!Array.isArray(ms) || !ms.length) throw new Error("Anthropic messages 为空");

  const body = {
    ...rd,
    model: m,
    max_tokens: maxTokens,
    messages: ms,
    stream: Boolean(stream)
  };
  if (typeof system === "string" && system.trim()) body.system = system.trim();
  const ts = dedupeAnthropicTools(tools);
  if (ts.length) {
    body.tools = ts;
    if (includeToolChoice !== false) body.tool_choice = { type: "auto" };
  }
  const headers = withJsonContentType(anthropicAuthHeaders(key, extraHeaders));
  if (stream) headers.accept = "text/event-stream";
  return { url, headers, body };
}

function buildMinimalRetryRequestDefaults(requestDefaults) {
  return { max_tokens: pickMaxTokens(requestDefaults) };
}

function formatAttemptLabel(i, labelSuffix) {
  if (!i) return "first";
  const s = String(labelSuffix || "").replace(/^:/, "").trim();
  return s ? `retry${i}(${s})` : `retry${i}`;
}

async function postAnthropicWithFallbacks({ baseLabel, timeoutMs, abortSignal, attempts }) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (!list.length) throw new Error("Anthropic post attempts 为空");

  const errors = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i] && typeof list[i] === "object" ? list[i] : {};
    const labelSuffix = normalizeString(a.labelSuffix);
    const { url, headers, body } = buildAnthropicRequest(a.request);
    const resp = await fetchWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: `${baseLabel}${labelSuffix}` });
    if (resp.ok) return resp;

    const text = await readHttpErrorDetail(resp, { maxChars: 500 });
    errors.push({ status: resp.status, text, labelSuffix });

    const retryable = ANTHROPIC_FALLBACK_STATUSES.has(resp.status);
    const hasNext = i + 1 < list.length;
    if (retryable && hasNext) {
      const hint = normalizeString(a.retryHint);
      debug(`${baseLabel} fallback: ${hint || "retry"} (status=${resp.status}, body=${truncateText(text, 200)})`);
      continue;
    }
    break;
  }

  const last = errors[errors.length - 1];
  const parts = errors.map((e, idx) => `${formatAttemptLabel(idx, e.labelSuffix)}: ${e.text}`);
  throw new Error(`${baseLabel} ${last?.status ?? ""}: ${parts.join(" | ")}`.trim());
}

async function anthropicCompleteText({ baseUrl, apiKey, model, system, messages, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const minimalDefaults = buildMinimalRetryRequestDefaults(requestDefaults);
  const resp = await postAnthropicWithFallbacks({
    baseLabel: "Anthropic",
    timeoutMs,
    abortSignal,
    attempts: [
      { labelSuffix: "", request: { baseUrl, apiKey, model, system, messages, tools: [], extraHeaders, requestDefaults, stream: false }, retryHint: "retry with minimal requestDefaults" },
      { labelSuffix: ":minimal-defaults", request: { baseUrl, apiKey, model, system, messages, tools: [], extraHeaders, requestDefaults: minimalDefaults, stream: false } }
    ]
  });

  const json = await resp.json().catch(() => null);
  const extractText = (obj) => {
    const rec = obj && typeof obj === "object" ? obj : null;
    if (!rec) return "";
    if (typeof rec.content === "string" && rec.content.trim()) return rec.content;
    const blocks = Array.isArray(rec.content) ? rec.content : [];
    const text = blocks.map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
    if (text.trim()) return text;
    return "";
  };

  const out = extractText(json) || extractText(json?.message) || normalizeString(json?.completion ?? json?.output_text ?? json?.outputText ?? json?.text);
  if (out) return out;

  // 兼容部分网关：OpenAI 形状（choices[0].message.content 或 choices[0].text）
  const oai = json && typeof json === "object" ? json : {};
  const choice0 = Array.isArray(oai.choices) ? oai.choices[0] : null;
  const m = choice0 && typeof choice0 === "object" ? choice0.message : null;
  const oaiText = normalizeString(m?.content) || normalizeString(choice0?.text);
  if (oaiText) return oaiText;

  const types = Array.isArray(json?.content)
    ? json.content
        .map((b) => normalizeString(b?.type) || "unknown")
        .filter(Boolean)
        .slice(0, 10)
        .join(",")
    : "";
  throw new Error(`Anthropic 响应缺少可解析文本（content_types=${types || "n/a"}）`.trim());
}

async function* anthropicStreamTextDeltas({ baseUrl, apiKey, model, system, messages, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const minimalDefaults = buildMinimalRetryRequestDefaults(requestDefaults);
  const resp = await postAnthropicWithFallbacks({
    baseLabel: "Anthropic(stream)",
    timeoutMs,
    abortSignal,
    attempts: [
      { labelSuffix: "", request: { baseUrl, apiKey, model, system, messages, tools: [], extraHeaders, requestDefaults, stream: true }, retryHint: "retry with minimal requestDefaults" },
      { labelSuffix: ":minimal-defaults", request: { baseUrl, apiKey, model, system, messages, tools: [], extraHeaders, requestDefaults: minimalDefaults, stream: true } }
    ]
  });

  await assertSseResponse(resp, { label: "Anthropic(stream)", expectedHint: "请确认 baseUrl 指向 Anthropic /messages SSE" });
  let dataEvents = 0;
  let parsedChunks = 0;
  let emitted = 0;
  for await (const ev of parseSse(resp)) {
    const data = normalizeString(ev?.data);
    if (!data) continue;
    dataEvents += 1;
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    parsedChunks += 1;
    if (json && typeof json === "object" && (json.type === "error" || json.error)) {
      const msg = normalizeString(extractErrorMessageFromJson(json)) || "upstream error";
      throw new Error(`Anthropic(stream) upstream error: ${msg}`.trim());
    }
    if (json?.type === "message_stop") break;
    if (json?.type === "content_block_delta" && json.delta && json.delta.type === "text_delta" && typeof json.delta.text === "string") {
      const t = json.delta.text;
      if (t) { emitted += 1; yield t; }
    }
  }
  if (emitted === 0) throw new Error(`Anthropic(stream) 未解析到任何 SSE delta（data_events=${dataEvents}, parsed_chunks=${parsedChunks}）；请检查 baseUrl 是否为 Anthropic SSE`.trim());
}

async function* anthropicChatStreamChunks({ baseUrl, apiKey, model, system, messages, tools, timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart }) {
  const minimalDefaults = buildMinimalRetryRequestDefaults(requestDefaults);
  const strippedMessages = stripAnthropicToolBlocksFromMessages(messages, { maxToolTextLen: 8000 });
  const resp = await postAnthropicWithFallbacks({
    baseLabel: "Anthropic(chat-stream)",
    timeoutMs,
    abortSignal,
    attempts: [
      {
        labelSuffix: "",
        request: { baseUrl, apiKey, model, system, messages, tools, extraHeaders, requestDefaults, stream: true, includeToolChoice: true },
        retryHint: "retry without tool_choice"
      },
      {
        labelSuffix: ":no-tool-choice",
        request: { baseUrl, apiKey, model, system, messages, tools, extraHeaders, requestDefaults, stream: true, includeToolChoice: false },
        retryHint: "retry without tools + strip tool blocks"
      },
      {
        labelSuffix: ":no-tools",
        request: { baseUrl, apiKey, model, system, messages: strippedMessages, tools: [], extraHeaders, requestDefaults: minimalDefaults, stream: true }
      }
    ]
  });

  await assertSseResponse(resp, { label: "Anthropic(chat-stream)", expectedHint: "请确认 baseUrl 指向 Anthropic /messages SSE" });

  const getToolMeta = makeToolMetaGetter(toolMetaByName);

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
  let dataEvents = 0;
  let parsedChunks = 0;
  let emittedChunks = 0;

  for await (const ev of parseSse(resp)) {
    const data = normalizeString(ev?.data);
    if (!data) continue;
    dataEvents += 1;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    parsedChunks += 1;
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
        emittedChunks += 1;
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
          emittedChunks += 1;
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
            emittedChunks += 1;
            yield makeBackChatChunk({ text: "", nodes: [toolUseStartNode({ id: nodeId, toolUseId: id, toolName: name, inputJson, mcpServerName: meta.mcpServerName, mcpToolName: meta.mcpToolName })] });
          }
          nodeId += 1;
          emittedChunks += 1;
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
      const msg = normalizeString(extractErrorMessageFromJson(json)) || "upstream error event";
      throw new Error(`Anthropic(chat-stream) upstream error event: ${msg}`.trim());
    }
  }

  if (currentBlockType === "thinking") {
    const summary = normalizeString(thinkingBuf);
    if (summary) {
      nodeId += 1;
      emittedChunks += 1;
      yield makeBackChatChunk({ text: "", nodes: [thinkingNode({ id: nodeId, summary })] });
    }
  }

  const hasUsage = usageInputTokens != null || usageOutputTokens != null || usageCacheReadInputTokens != null || usageCacheCreationInputTokens != null;
  if (emittedChunks === 0 && !hasUsage && !sawToolUse) {
    throw new Error(`Anthropic(chat-stream) 未解析到任何上游 SSE 内容（data_events=${dataEvents}, parsed_chunks=${parsedChunks}）；请检查 baseUrl 是否为 Anthropic /messages SSE`);
  }

  if (hasUsage) {
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
