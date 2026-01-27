"use strict";

const { debug, warn } = require("../../../infra/log");
const { normalizeString } = require("../../../infra/util");
const { captureAugmentToolDefinitions } = require("../../../config/state");
const { resolveExtraSystemPrompt } = require("../../../config/prompts");
const { maybeSummarizeAndCompactAugmentChatRequest } = require("../../../core/augment-history-summary/auto");
const { normalizeAugmentChatRequest } = require("../../../core/augment-chat");
const { shouldRequestThinking, stripThinkingAndReasoningFromRequestDefaults } = require("../../../core/thinking-control");
const { maybeInjectOfficialCodebaseRetrieval } = require("../../official/codebase-retrieval");
const { maybeInjectOfficialContextCanvas } = require("../../official/context-canvas");
const { maybeInjectOfficialExternalSources } = require("../../official/external-sources");
const { maybeHydrateAssetNodesFromUpstream } = require("../../upstream/assets");
const { maybeHydrateCheckpointNodesFromUpstream } = require("../../upstream/checkpoints");
const { deriveWorkspaceFileChunksFromRequest } = require("../../workspace/file-chunks");
const { providerLabel, providerRequestContext } = require("../common");

function captureAugmentChatToolDefinitions({ endpoint, req, provider, providerType, requestedModel, conversationId, requestId }) {
  const ep = normalizeString(endpoint);
  if (!ep) return false;
  const r = req && typeof req === "object" ? req : {};
  try {
    captureAugmentToolDefinitions(r.tool_definitions, {
      endpoint: ep,
      providerId: normalizeString(provider?.id),
      providerType: normalizeString(providerType),
      requestedModel: normalizeString(requestedModel),
      conversationId: normalizeString(conversationId),
      ...(requestId ? { requestId: normalizeString(requestId) } : {})
    });
    return true;
  } catch {
    return false;
  }
}

function summarizeAugmentChatRequest(req) {
  const r = req && typeof req === "object" ? req : {};
  const msg = normalizeString(r.message);
  const hasNodes = Array.isArray(r.nodes) && r.nodes.length;
  const hasHistory = Array.isArray(r.chat_history) && r.chat_history.length;
  const hasReqNodes =
    (Array.isArray(r.structured_request_nodes) && r.structured_request_nodes.length) ||
    (Array.isArray(r.request_nodes) && r.request_nodes.length);
  const toolDefs = Array.isArray(r.tool_definitions) ? r.tool_definitions.length : 0;
  return { msg, hasNodes, hasHistory, hasReqNodes, toolDefs };
}

function isAugmentChatRequestEmpty(summary) {
  const s = summary && typeof summary === "object" ? summary : {};
  return !normalizeString(s.msg) && !s.hasNodes && !s.hasHistory && !s.hasReqNodes;
}

function logAugmentChatStart({ kind, requestId, provider, providerType, model, requestedModel, conversationId, summary }) {
  const label = normalizeString(kind) === "chat-stream" ? "chat-stream" : "chat";
  const rid = normalizeString(requestId);
  const s = summary && typeof summary === "object" ? summary : {};
  const msgLen = normalizeString(s.msg).length;

  debug(
    `[${label}] start${rid ? ` rid=${rid}` : ""} provider=${providerLabel(provider)} type=${normalizeString(providerType) || "unknown"} model=${normalizeString(model) || "unknown"} requestedModel=${normalizeString(requestedModel) || "unknown"} conv=${normalizeString(conversationId) || "n/a"} tool_defs=${Number(s.toolDefs) || 0} msg_len=${msgLen} has_nodes=${String(Boolean(s.hasNodes))} has_history=${String(Boolean(s.hasHistory))} has_req_nodes=${String(Boolean(s.hasReqNodes))}`
  );
}

async function prepareAugmentChatRequestForByok({ cfg, req, requestedModel, fallbackProvider, fallbackModel, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken, requestId }) {
  const rid = normalizeString(requestId);
  const meta = { checkpointNotFound: false, workspaceFileChunks: [] };

  const runStep = async (label, fn) => {
    try {
      return await fn();
    } catch (err) {
      warn(label, { requestId: rid, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };

  await runStep("upstream assets hydrate failed (ignored)", async () => await maybeHydrateAssetNodesFromUpstream(req, { timeoutMs, abortSignal }));

  const checkpointRes = await runStep(
    "upstream checkpoints hydrate failed (ignored)",
    async () => await maybeHydrateCheckpointNodesFromUpstream(req, { timeoutMs, abortSignal })
  );
  if (checkpointRes && typeof checkpointRes === "object" && checkpointRes.checkpointNotFound === true) meta.checkpointNotFound = true;

  await runStep("historySummary failed (ignored)", async () => await maybeSummarizeAndCompactAugmentChatRequest({ cfg, req, requestedModel, fallbackProvider, fallbackModel, timeoutMs, abortSignal }));
  await runStep("official codebase retrieval inject failed (ignored)", async () => await maybeInjectOfficialCodebaseRetrieval({ req, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken }));
  await runStep("official context canvas inject failed (ignored)", async () => await maybeInjectOfficialContextCanvas({ req, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken }));
  await runStep("official external sources inject failed (ignored)", async () => await maybeInjectOfficialExternalSources({ req, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken }));

  try {
    meta.workspaceFileChunks = deriveWorkspaceFileChunksFromRequest(req, { maxChunks: 80 });
  } catch {
    meta.workspaceFileChunks = [];
  }

  return meta;
}

function resolveSupportToolUseStart(req) {
  const r = req && typeof req === "object" ? req : {};
  const fdf = r.feature_detection_flags && typeof r.feature_detection_flags === "object" ? r.feature_detection_flags : {};
  return fdf.support_tool_use_start === true || fdf.supportToolUseStart === true;
}

function resolveSupportParallelToolUse(req) {
  const r = req && typeof req === "object" ? req : {};
  const fdf = r.feature_detection_flags && typeof r.feature_detection_flags === "object" ? r.feature_detection_flags : {};
  return fdf.support_parallel_tool_use === true || fdf.supportParallelToolUse === true;
}

async function buildByokAugmentChatContext({ kind, endpoint, cfg, provider, model, requestedModel, body, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken, requestId }) {
  const label = normalizeString(kind) === "chat-stream" ? "chat-stream" : "chat";
  const ep = normalizeString(endpoint) || (label === "chat-stream" ? "/chat-stream" : "/chat");

  const prc = providerRequestContext(provider);
  const { type, baseUrl, apiKey, extraHeaders } = prc;
  let requestDefaults = prc.requestDefaults;
  const req = normalizeAugmentChatRequest(body);
  const byokExtraSystem = resolveExtraSystemPrompt(cfg, ep);
  if (byokExtraSystem) req.byok_system_prompt = byokExtraSystem;
  const conversationId = normalizeString(req?.conversation_id ?? req?.conversationId ?? req?.conversationID);
  const rid = normalizeString(requestId);

  // 非用户对话轮次（例如工具回填后的 continuation）不需要上游“thinking/reasoning”，避免多次思考导致开销/中断。
  if (!shouldRequestThinking(req)) {
    requestDefaults = stripThinkingAndReasoningFromRequestDefaults(requestDefaults);
  }

  captureAugmentChatToolDefinitions({
    endpoint: ep,
    req,
    provider,
    providerType: type,
    requestedModel,
    conversationId,
    requestId: rid
  });

  const summary = summarizeAugmentChatRequest(req);
  logAugmentChatStart({ kind: label, requestId: rid, provider, providerType: type, model, requestedModel, conversationId, summary });

  const traceLabel = `[${label}] upstream${rid ? ` rid=${rid}` : ""} provider=${providerLabel(provider)} type=${type || "unknown"} model=${normalizeString(model) || "unknown"}`;

  if (isAugmentChatRequestEmpty(summary)) {
    return {
      kind: label,
      ep,
      rid,
      conversationId,
      type,
      baseUrl,
      apiKey,
      extraHeaders,
      requestDefaults,
      req,
      summary,
      checkpointNotFound: false,
      workspaceFileChunks: [],
      traceLabel,
      empty: true
    };
  }

  const prep = await prepareAugmentChatRequestForByok({
    cfg,
    req,
    requestedModel,
    fallbackProvider: provider,
    fallbackModel: model,
    timeoutMs,
    abortSignal,
    upstreamCompletionURL,
    upstreamApiToken,
    requestId: rid
  });
  const checkpointNotFound = prep && typeof prep === "object" && prep.checkpointNotFound === true;
  const workspaceFileChunks = prep && typeof prep === "object" && Array.isArray(prep.workspaceFileChunks) ? prep.workspaceFileChunks : [];

  return {
    kind: label,
    ep,
    rid,
    conversationId,
    type,
    baseUrl,
    apiKey,
    extraHeaders,
    requestDefaults,
    req,
    summary,
    checkpointNotFound,
    workspaceFileChunks,
    traceLabel,
    empty: false
  };
}

module.exports = {
  resolveSupportToolUseStart,
  resolveSupportParallelToolUse,
  buildByokAugmentChatContext
};
