"use strict";

const { warn } = require("../infra/log");
const { ensureConfigManager, state } = require("../config/state");
const { decideRoute } = require("../core/router");
const { normalizeEndpoint, normalizeString, safeTransform, emptyAsyncGenerator } = require("../infra/util");
const { ensureModelRegistryFeatureFlags } = require("../core/model-registry");
const { openAiCompleteText, openAiStreamTextDeltas, openAiChatStreamChunks } = require("../providers/openai");
const { anthropicCompleteText, anthropicStreamTextDeltas, anthropicChatStreamChunks } = require("../providers/anthropic");
const { joinBaseUrl, safeFetch, readTextLimit } = require("../providers/http");
const { getOfficialConnection } = require("../config/official");
const { normalizeAugmentChatRequest, buildSystemPrompt, convertOpenAiTools, convertAnthropicTools, buildToolMetaByName, buildOpenAiMessages, buildAnthropicMessages } = require("../core/augment-chat");
const { STOP_REASON_END_TURN, makeBackChatChunk } = require("../core/augment-protocol");
const {
  buildMessagesForEndpoint,
  makeBackTextResult,
  makeBackChatResult,
  makeBackCompletionResult,
  makeBackGenerateCommitMessageChunk,
  makeBackNextEditGenerationChunk,
  makeBackNextEditLocationResult,
  buildByokModelsFromConfig,
  makeBackGetModelsResult,
  makeModelInfo
} = require("../core/protocol");

function resolveProviderApiKey(provider, label) {
  if (!provider || typeof provider !== "object") throw new Error(`${label} provider 无效`);
  const key = normalizeString(provider.apiKey);
  if (key) return key;
  throw new Error(`${label} 未配置 api_key`);
}

function providerLabel(provider) {
  const id = normalizeString(provider?.id);
  const type = normalizeString(provider?.type);
  return `Provider(${id || type || "unknown"})`;
}

function providerRequestContext(provider) {
  if (!provider || typeof provider !== "object") throw new Error("BYOK provider 未选择");
  const type = normalizeString(provider.type);
  const baseUrl = normalizeString(provider.baseUrl);
  const apiKey = resolveProviderApiKey(provider, providerLabel(provider));
  const extraHeaders = provider.headers && typeof provider.headers === "object" ? provider.headers : {};
  const requestDefaults = provider.requestDefaults && typeof provider.requestDefaults === "object" ? provider.requestDefaults : {};
  return { type, baseUrl, apiKey, extraHeaders, requestDefaults };
}

function asOpenAiMessages(system, messages) {
  const sys = typeof system === "string" ? system : "";
  const ms = Array.isArray(messages) ? messages : [];
  return [{ role: "system", content: sys }, ...ms].filter((m) => m && typeof m.content === "string" && m.content);
}

function asAnthropicMessages(system, messages) {
  const sys = normalizeString(system);
  const ms = Array.isArray(messages) ? messages : [];
  const out = ms
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content)
    .map((m) => ({ role: m.role, content: m.content }));
  return { system: sys, messages: out };
}

function isTelemetryDisabled(cfg, ep) {
  const list = Array.isArray(cfg?.telemetry?.disabledEndpoints) ? cfg.telemetry.disabledEndpoints : [];
  return list.includes(ep);
}

function normalizeLineNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  return Math.floor(n);
}

function pickNextEditLocationCandidates(body) {
  const b = body && typeof body === "object" ? body : {};
  const max =
    Number.isFinite(Number(b.num_results)) && Number(b.num_results) > 0 ? Math.min(6, Math.floor(Number(b.num_results))) : 1;

  const out = [];
  const diags = Array.isArray(b.diagnostics) ? b.diagnostics : [];
  for (const d of diags) {
    const path = normalizeString(d?.path || d?.file_path || d?.filePath || d?.item?.path);
    if (!path) continue;
    const r = d?.range || d?.item?.range || d?.location?.range;
    const start = normalizeLineNumber(r?.start?.line ?? r?.start_line ?? r?.startLine ?? r?.start);
    if (start === null) continue;
    const stop = normalizeLineNumber(r?.end?.line ?? r?.stop?.line ?? r?.end_line ?? r?.stopLine ?? r?.stop ?? start) ?? start;
    out.push({ item: { path, range: { start, stop: Math.max(start, stop) } }, score: 1, debug_info: { source: "diagnostic" } });
    if (out.length >= max) break;
  }

  if (!out.length) {
    const path = normalizeString(b.path);
    if (path) out.push({ item: { path, range: { start: 0, stop: 0 } }, score: 1, debug_info: { source: "fallback" } });
  }

  return out;
}

async function byokCompleteText({ provider, model, system, messages, timeoutMs, abortSignal }) {
  const { type, baseUrl, apiKey, extraHeaders, requestDefaults } = providerRequestContext(provider);

  if (type === "openai_compatible") {
    return await openAiCompleteText({
      baseUrl,
      apiKey,
      model,
      messages: asOpenAiMessages(system, messages),
      timeoutMs,
      abortSignal,
      extraHeaders,
      requestDefaults
    });
  }
  if (type === "anthropic") {
    const { system: sys, messages: msgs } = asAnthropicMessages(system, messages);
    return await anthropicCompleteText({ baseUrl, apiKey, model, system: sys, messages: msgs, timeoutMs, abortSignal, extraHeaders, requestDefaults });
  }
  throw new Error(`未知 provider.type: ${type}`);
}

async function* byokStreamText({ provider, model, system, messages, timeoutMs, abortSignal }) {
  const { type, baseUrl, apiKey, extraHeaders, requestDefaults } = providerRequestContext(provider);

  if (type === "openai_compatible") {
    yield* openAiStreamTextDeltas({
      baseUrl,
      apiKey,
      model,
      messages: asOpenAiMessages(system, messages),
      timeoutMs,
      abortSignal,
      extraHeaders,
      requestDefaults
    });
    return;
  }
  if (type === "anthropic") {
    const { system: sys, messages: msgs } = asAnthropicMessages(system, messages);
    yield* anthropicStreamTextDeltas({ baseUrl, apiKey, model, system: sys, messages: msgs, timeoutMs, abortSignal, extraHeaders, requestDefaults });
    return;
  }
  throw new Error(`未知 provider.type: ${type}`);
}

async function* byokChatStream({ provider, model, body, timeoutMs, abortSignal }) {
  const { type, baseUrl, apiKey, extraHeaders, requestDefaults } = providerRequestContext(provider);
  const req = normalizeAugmentChatRequest(body);
  const msg = normalizeString(req.message);
  const hasNodes = Array.isArray(req.nodes) && req.nodes.length;
  const hasHistory = Array.isArray(req.chat_history) && req.chat_history.length;
  const hasReqNodes = (Array.isArray(req.structured_request_nodes) && req.structured_request_nodes.length) || (Array.isArray(req.request_nodes) && req.request_nodes.length);
  if (!msg && !hasNodes && !hasHistory && !hasReqNodes) {
    yield makeBackChatChunk({ text: "", stop_reason: STOP_REASON_END_TURN });
    return;
  }
  const toolMetaByName = buildToolMetaByName(req.tool_definitions);
  const fdf = req && typeof req === "object" && req.feature_detection_flags && typeof req.feature_detection_flags === "object" ? req.feature_detection_flags : {};
  const supportToolUseStart = fdf.support_tool_use_start === true || fdf.supportToolUseStart === true;
  if (type === "openai_compatible") {
    yield* openAiChatStreamChunks({ baseUrl, apiKey, model, messages: buildOpenAiMessages(req), tools: convertOpenAiTools(req.tool_definitions), timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart });
    return;
  }
  if (type === "anthropic") {
    yield* anthropicChatStreamChunks({ baseUrl, apiKey, model, system: buildSystemPrompt(req), messages: buildAnthropicMessages(req), tools: convertAnthropicTools(req.tool_definitions), timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart });
    return;
  }
  throw new Error(`未知 provider.type: ${type}`);
}

async function fetchOfficialGetModels({ completionURL, apiToken, timeoutMs, abortSignal }) {
  const url = joinBaseUrl(normalizeString(completionURL), "get-models");
  if (!url) throw new Error("completionURL 无效（无法请求官方 get-models）");
  const headers = { "content-type": "application/json" };
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;
  const resp = await safeFetch(url, { method: "POST", headers, body: "{}" }, { timeoutMs, abortSignal, label: "augment/get-models" });
  if (!resp.ok) throw new Error(`get-models ${resp.status}: ${await readTextLimit(resp, 300)}`.trim());
  const json = await resp.json().catch(() => null);
  if (!json || typeof json !== "object") throw new Error("get-models 响应不是 JSON 对象");
  return json;
}

function mergeModels(upstreamJson, byokModelNames) {
  const base = upstreamJson && typeof upstreamJson === "object" ? upstreamJson : {};
  const models = Array.isArray(base.models) ? base.models.slice() : [];
  const existing = new Set(models.map((m) => (m && typeof m.name === "string" ? m.name : "")).filter(Boolean));
  for (const name of byokModelNames) {
    if (!name || existing.has(name)) continue;
    models.push(makeModelInfo(name));
    existing.add(name);
  }
  const defaultModel = typeof base.default_model === "string" && base.default_model ? base.default_model : (models[0]?.name || "unknown");
  const baseFlags = base.feature_flags && typeof base.feature_flags === "object" && !Array.isArray(base.feature_flags) ? base.feature_flags : {};
  const flags = ensureModelRegistryFeatureFlags(baseFlags, { byokModelIds: byokModelNames, defaultModel });
  return { ...base, default_model: defaultModel, models, feature_flags: flags };
}

async function maybeHandleCallApi({ endpoint, body, transform, timeoutMs, abortSignal, upstreamApiToken }) {
  const ep = normalizeEndpoint(endpoint);
  if (!ep) return undefined;

  const cfgMgr = ensureConfigManager();
  const cfg = cfgMgr.get();
  if (!state.runtimeEnabled) return undefined;

  if (isTelemetryDisabled(cfg, ep)) {
    try {
      return safeTransform(transform, {}, `telemetry:${ep}`);
    } catch (err) {
      warn(`telemetry stub transform failed, fallback official: ${ep}`);
      return undefined;
    }
  }

  const route = decideRoute({ cfg, endpoint: ep, body, runtimeEnabled: state.runtimeEnabled });
  if (route.mode === "official") return undefined;
  if (route.mode === "disabled") throw new Error(`BYOK disabled endpoint: ${ep}`);
  if (route.mode !== "byok") return undefined;

  const t = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : cfg.timeouts.upstreamMs;

  if (ep === "/get-models") {
    const byokModels = buildByokModelsFromConfig(cfg);
    try {
      const off = getOfficialConnection();
      const completionURL = off.completionURL;
      const apiToken = normalizeString(upstreamApiToken) || off.apiToken;
      const upstream = await fetchOfficialGetModels({ completionURL, apiToken, timeoutMs: Math.min(12000, t), abortSignal });
      const merged = mergeModels(upstream, byokModels);
      return safeTransform(transform, merged, ep);
    } catch (err) {
      warn(`get-models fallback to local: ${err instanceof Error ? err.message : String(err)}`);
      const local = makeBackGetModelsResult({ defaultModel: byokModels[0] || "unknown", models: byokModels.map(makeModelInfo) });
      return safeTransform(transform, local, ep);
    }
  }

  if (ep === "/completion" || ep === "/chat-input-completion") {
    const { system, messages } = buildMessagesForEndpoint(ep, body);
    const text = await byokCompleteText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal });
    return safeTransform(transform, makeBackCompletionResult(text, { timeoutMs: t }), ep);
  }

  if (ep === "/edit") {
    const { system, messages } = buildMessagesForEndpoint(ep, body);
    const text = await byokCompleteText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal });
    return safeTransform(transform, makeBackTextResult(text), ep);
  }

  if (ep === "/chat") {
    const { system, messages } = buildMessagesForEndpoint(ep, body);
    const text = await byokCompleteText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal });
    return safeTransform(transform, makeBackChatResult(text, { nodes: [] }), ep);
  }

  if (ep === "/next_edit_loc") {
    const candidate_locations = pickNextEditLocationCandidates(body);
    return safeTransform(transform, makeBackNextEditLocationResult(candidate_locations), ep);
  }

  return undefined;
}

async function maybeHandleCallApiStream({ endpoint, body, transform, timeoutMs, abortSignal }) {
  const ep = normalizeEndpoint(endpoint);
  if (!ep) return undefined;

  const cfgMgr = ensureConfigManager();
  const cfg = cfgMgr.get();
  if (!state.runtimeEnabled) return undefined;

  const route = decideRoute({ cfg, endpoint: ep, body, runtimeEnabled: state.runtimeEnabled });
  if (route.mode === "official") return undefined;
  if (route.mode === "disabled") throw new Error(`BYOK disabled endpoint: ${ep}`);
  if (route.mode !== "byok") return undefined;

  const t = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : cfg.timeouts.upstreamMs;

  if (isTelemetryDisabled(cfg, ep)) return emptyAsyncGenerator();

  if (ep === "/chat-stream") {
    const src = byokChatStream({ provider: route.provider, model: route.model, body, timeoutMs: t, abortSignal });
    return (async function* () { for await (const raw of src) yield safeTransform(transform, raw, ep); })();
  }

  if (ep === "/prompt-enhancer" || ep === "/generate-conversation-title") {
    const { system, messages } = buildMessagesForEndpoint(ep, body);
    const src = byokStreamText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal });
    return (async function* () {
      for await (const delta of src) yield safeTransform(transform, makeBackChatResult(delta, { nodes: [] }), ep);
    })();
  }

  if (ep === "/instruction-stream" || ep === "/smart-paste-stream") {
    const { system, messages } = buildMessagesForEndpoint(ep, body);
    const src = byokStreamText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal });
    return (async function* () {
      for await (const delta of src) yield safeTransform(transform, makeBackTextResult(delta), ep);
    })();
  }

  if (ep === "/generate-commit-message-stream") {
    const { system, messages } = buildMessagesForEndpoint(ep, body);
    const src = byokStreamText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal });
    return (async function* () {
      for await (const delta of src) yield safeTransform(transform, makeBackGenerateCommitMessageChunk(delta), ep);
    })();
  }

  if (ep === "/next-edit-stream") {
    const b = body && typeof body === "object" ? body : {};
    const selectionBegin = Number.isFinite(Number(b.selection_begin_char)) ? Number(b.selection_begin_char) : 0;
    const selectionEnd = Number.isFinite(Number(b.selection_end_char)) ? Number(b.selection_end_char) : selectionBegin;
    const existingCode = typeof b.selected_text === "string" ? b.selected_text : "";

    const { system, messages } = buildMessagesForEndpoint(ep, body);
    const suggestedCode = await byokCompleteText({ provider: route.provider, model: route.model, system, messages, timeoutMs: t, abortSignal });

    const raw = makeBackNextEditGenerationChunk({
      path: normalizeString(b.path),
      blobName: normalizeString(b.blob_name),
      charStart: selectionBegin,
      charEnd: selectionEnd,
      existingCode,
      suggestedCode
    });
    return (async function* () { yield safeTransform(transform, raw, ep); })();
  }

  return undefined;
}

module.exports = { maybeHandleCallApi, maybeHandleCallApiStream };
