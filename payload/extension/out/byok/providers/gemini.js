"use strict";

const { joinBaseUrl } = require("./http");
const { parseSse } = require("./sse");
const { normalizeString, requireString, normalizeRawToken, stripByokInternalKeys } = require("../infra/util");
const { withJsonContentType } = require("./headers");
const { normalizeUsageInt, makeToolMetaGetter, assertSseResponse } = require("./provider-util");
const { fetchOkWithRetry, extractErrorMessageFromJson } = require("./request-util");
const {
  STOP_REASON_END_TURN,
  STOP_REASON_MAX_TOKENS,
  STOP_REASON_TOOL_USE_REQUESTED,
  STOP_REASON_SAFETY,
  STOP_REASON_RECITATION,
  STOP_REASON_MALFORMED_FUNCTION_CALL,
  rawResponseNode,
  toolUseStartNode,
  toolUseNode,
  mainTextFinishedNode,
  tokenUsageNode,
  makeBackChatChunk
} = require("../core/augment-protocol");

function normalizeGeminiModel(model) {
  const m = requireString(model, "Gemini model");
  if (m.includes("/")) return m;
  return `models/${m}`;
}

function mapGeminiFinishReasonToAugment(reason) {
  const r = normalizeString(reason).trim().toUpperCase();
  if (r === "STOP") return STOP_REASON_END_TURN;
  if (r === "MAX_TOKENS") return STOP_REASON_MAX_TOKENS;
  if (r === "SAFETY") return STOP_REASON_SAFETY;
  if (r === "RECITATION") return STOP_REASON_RECITATION;
  if (r === "MALFORMED_FUNCTION_CALL") return STOP_REASON_MALFORMED_FUNCTION_CALL;
  return STOP_REASON_END_TURN;
}

function buildGeminiRequest({ baseUrl, apiKey, model, systemInstruction, contents, tools, extraHeaders, requestDefaults, stream }) {
  const b = requireString(baseUrl, "Gemini baseUrl");
  const key = normalizeRawToken(apiKey);
  const extra = extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {};
  if (!key && Object.keys(extra).length === 0) throw new Error("Gemini apiKey 未配置（且 headers 为空）");

  const m = normalizeGeminiModel(model);
  const endpoint = stream ? `${m}:streamGenerateContent` : `${m}:generateContent`;
  const url0 = joinBaseUrl(b, b.includes("/v1beta") ? endpoint : `v1beta/${endpoint}`);
  if (!url0) throw new Error("Gemini URL 构造失败（请检查 baseUrl/model）");

  const u = new URL(url0);
  if (key) u.searchParams.set("key", key);
  if (stream) u.searchParams.set("alt", "sse");

  const rd = stripByokInternalKeys(requestDefaults);
  const body = { ...rd, contents: Array.isArray(contents) ? contents : [] };
  const sys = normalizeString(systemInstruction);
  if (sys && !body.systemInstruction) body.systemInstruction = { parts: [{ text: sys.trim() }] };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    if (!body.toolConfig) body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }

  const headers = withJsonContentType(extraHeaders);
  if (stream) headers.accept = "text/event-stream";
  return { url: u.toString(), headers, body };
}

function extractGeminiTextFromResponse(json) {
  const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
  const parts = candidates[0]?.content?.parts;
  const list = Array.isArray(parts) ? parts : [];
  let out = "";
  for (const p of list) if (p && typeof p === "object" && typeof p.text === "string" && p.text) out += p.text;
  return out;
}

async function geminiCompleteText({ baseUrl, apiKey, model, systemInstruction, contents, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const { url, headers, body } = buildGeminiRequest({ baseUrl, apiKey, model, systemInstruction, contents, tools: [], extraHeaders, requestDefaults, stream: false });
  const resp = await fetchOkWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: "Gemini" });
  const json = await resp.json().catch(() => null);
  const text = extractGeminiTextFromResponse(json);
  if (!text) throw new Error("Gemini 响应缺少 candidates[0].content.parts[].text");
  return text;
}

async function* geminiStreamTextDeltas({ baseUrl, apiKey, model, systemInstruction, contents, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const { url, headers, body } = buildGeminiRequest({ baseUrl, apiKey, model, systemInstruction, contents, tools: [], extraHeaders, requestDefaults, stream: true });
  const resp = await fetchOkWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: "Gemini(stream)" });
  await assertSseResponse(resp, { label: "Gemini(stream)", expectedHint: "请确认 baseUrl 指向 Google Generative Language API" });

  let dataEvents = 0;
  let parsedChunks = 0;
  let emitted = 0;
  let fullText = "";

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
      throw new Error(`Gemini(stream) upstream error: ${msg}`.trim());
    }
    const chunk = extractGeminiTextFromResponse(json);
    if (!chunk) continue;

    let delta = chunk;
    if (chunk.startsWith(fullText)) {
      delta = chunk.slice(fullText.length);
      fullText = chunk;
    } else {
      fullText += chunk;
    }
    if (delta) {
      emitted += 1;
      yield delta;
    }
  }

  if (emitted === 0) throw new Error(`Gemini(stream) 未解析到任何 SSE delta（data_events=${dataEvents}, parsed_chunks=${parsedChunks}）；请检查 baseUrl 是否为 Gemini SSE`.trim());
}

function sanitizeToolHint(toolName) {
  const t = normalizeString(toolName);
  return t.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 48) || "tool";
}

function normalizeFunctionCallArgsToJsonString(args) {
  if (typeof args === "string") return normalizeString(args) || "{}";
  if (args && typeof args === "object") {
    try {
      return JSON.stringify(args);
    } catch {
      return "{}";
    }
  }
  return "{}";
}

async function* geminiChatStreamChunks({ baseUrl, apiKey, model, systemInstruction, contents, tools, timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart }) {
  const getToolMeta = makeToolMetaGetter(toolMetaByName);

  const { url, headers, body } = buildGeminiRequest({ baseUrl, apiKey, model, systemInstruction, contents, tools, extraHeaders, requestDefaults, stream: true });
  const resp = await fetchOkWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: "Gemini(chat-stream)" });
  await assertSseResponse(resp, { label: "Gemini(chat-stream)", expectedHint: "请确认 baseUrl 指向 Gemini /streamGenerateContent SSE" });

  let nodeId = 0;
  let fullText = "";
  let stopReason = null;
  let stopReasonSeen = false;
  let sawToolUse = false;
  let usagePromptTokens = null;
  let usageCompletionTokens = null;
  let usageCacheReadInputTokens = null;
  let dataEvents = 0;
  let parsedChunks = 0;
  let emittedChunks = 0;
  let toolSeq = 0;

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

    if (json && typeof json === "object" && (json.error || json.message)) {
      const msg = normalizeString(extractErrorMessageFromJson(json)) || "upstream error";
      throw new Error(`Gemini(chat-stream) upstream error: ${msg}`.trim());
    }

    const um = json?.usageMetadata && typeof json.usageMetadata === "object" ? json.usageMetadata : json?.usage_metadata && typeof json.usage_metadata === "object" ? json.usage_metadata : null;
    if (um) {
      const pt = normalizeUsageInt(um.promptTokenCount ?? um.prompt_token_count);
      const ct = normalizeUsageInt(um.candidatesTokenCount ?? um.candidates_token_count);
      const cached = normalizeUsageInt(um.cachedContentTokenCount ?? um.cached_content_token_count ?? um.cachedTokenCount);
      if (pt != null) usagePromptTokens = pt;
      if (ct != null) usageCompletionTokens = ct;
      if (cached != null) usageCacheReadInputTokens = cached;
    }

    const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
    const c0 = candidates[0] && typeof candidates[0] === "object" ? candidates[0] : null;
    const fr = normalizeString(c0?.finishReason ?? c0?.finish_reason);
    if (fr) {
      stopReasonSeen = true;
      stopReason = mapGeminiFinishReasonToAugment(fr);
    }

    const parts = Array.isArray(c0?.content?.parts) ? c0.content.parts : [];
    let chunkText = "";
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      if (typeof p.text === "string" && p.text) {
        chunkText += p.text;
        continue;
      }
      const fc = p.functionCall && typeof p.functionCall === "object" ? p.functionCall : null;
      if (fc) {
        const toolName = normalizeString(fc.name);
        if (!toolName) continue;
        toolSeq += 1;
        const toolUseId = `tool-${sanitizeToolHint(toolName)}-${toolSeq}`;
        const inputJson = normalizeFunctionCallArgsToJsonString(fc.args ?? fc.arguments);
        const meta = getToolMeta(toolName);
        sawToolUse = true;
        if (supportToolUseStart === true) {
          nodeId += 1;
          emittedChunks += 1;
          yield makeBackChatChunk({
            text: "",
            nodes: [toolUseStartNode({ id: nodeId, toolUseId, toolName, inputJson, mcpServerName: meta.mcpServerName, mcpToolName: meta.mcpToolName })]
          });
        }
        nodeId += 1;
        emittedChunks += 1;
        yield makeBackChatChunk({
          text: "",
          nodes: [toolUseNode({ id: nodeId, toolUseId, toolName, inputJson, mcpServerName: meta.mcpServerName, mcpToolName: meta.mcpToolName })]
        });
      }
    }

    if (chunkText) {
      let delta = chunkText;
      if (chunkText.startsWith(fullText)) {
        delta = chunkText.slice(fullText.length);
        fullText = chunkText;
      } else {
        fullText += chunkText;
      }
      if (delta) {
        nodeId += 1;
        emittedChunks += 1;
        yield makeBackChatChunk({ text: delta, nodes: [rawResponseNode({ id: nodeId, content: delta })] });
      }
    }
  }

  const hasUsage = usagePromptTokens != null || usageCompletionTokens != null || usageCacheReadInputTokens != null;
  if (emittedChunks === 0 && !hasUsage && !sawToolUse) {
    throw new Error(`Gemini(chat-stream) 未解析到任何上游 SSE 内容（data_events=${dataEvents}, parsed_chunks=${parsedChunks}）；请检查 baseUrl 是否为 Gemini SSE`.trim());
  }

  if (hasUsage) {
    nodeId += 1;
    yield makeBackChatChunk({
      text: "",
      nodes: [tokenUsageNode({ id: nodeId, inputTokens: usagePromptTokens, outputTokens: usageCompletionTokens, cacheReadInputTokens: usageCacheReadInputTokens })]
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

module.exports = { geminiCompleteText, geminiStreamTextDeltas, geminiChatStreamChunks };
