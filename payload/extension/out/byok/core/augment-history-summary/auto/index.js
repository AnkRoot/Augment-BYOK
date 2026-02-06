"use strict";

const { debug } = require("../../../infra/log");
const { normalizeString, utf8ByteLen } = require("../../../infra/util");
const shared = require("../../augment-chat/shared");
const { buildAbridgedHistoryText, exchangeRequestNodes, exchangeResponseNodes } = require("../abridged");
const { REQUEST_NODE_HISTORY_SUMMARY } = require("../../augment-protocol");
const {
  setHistorySummaryStorage,
  cacheGetFresh,
  cacheGetFreshState,
  cachePut,
  deleteHistorySummaryCache,
  clearHistorySummaryCacheAll
} = require("../cache");
const { runSummaryModelOnce } = require("../provider-dispatch");

const {
  approxTokenCountFromByteLen,
  estimateRequestExtraSizeBytes,
  estimateHistorySizeBytes
} = require("./estimate");
const { resolveContextWindowTokens, resolveHistorySummaryConfig, pickProviderById } = require("./config");
const { computeTailSelection } = require("./tail-selection");
const {
  DEFAULT_SUMMARY_TAIL_REQUEST_IDS,
  exchangeRequestId,
  historyStartRequestId,
  tailRequestIds,
  computeRequestIdsHash
} = require("../consistency");

const { asRecord, asArray, asString, pick, normalizeNodeType } = shared;

const DEFAULT_SUMMARY_TAIL_HEAD_REQUEST_IDS = 64;

function nowMs() {
  return Date.now();
}

function buildPrevSummaryExchange(summaryText) {
  return {
    request_id: "byok_history_summary_prev",
    request_message: `[PREVIOUS_SUMMARY]\n${asString(summaryText).trim()}\n[/PREVIOUS_SUMMARY]`,
    response_text: "",
    request_nodes: [],
    structured_request_nodes: [],
    nodes: [],
    response_nodes: [],
    structured_output_nodes: []
  };
}

function buildRollingUpdatePrompt(hsPrompt) {
  return `${normalizeString(hsPrompt)}\n\nYou will be given an existing summary and additional conversation turns. The new turns may overlap with information already included in the summary, and the history may be incomplete due to truncation. Update the summary to include any NEW information, avoid duplication, and prefer the latest state when conflicts exist. Output only the updated summary.`;
}

function hasHistorySummaryNode(nodes) {
  return asArray(nodes).some(
    (n) =>
      normalizeNodeType(n) === REQUEST_NODE_HISTORY_SUMMARY &&
      pick(n, ["history_summary_node", "historySummaryNode"]) != null
  );
}

function historyContainsSummary(history) {
  return asArray(history).some((h) => {
    const it = asRecord(h);
    return hasHistorySummaryNode(it.request_nodes) || hasHistorySummaryNode(it.structured_request_nodes) || hasHistorySummaryNode(it.nodes);
  });
}

function requestContainsSummary(req) {
  const r = asRecord(req);
  const nodes = [...asArray(r.nodes), ...asArray(r.structured_request_nodes), ...asArray(r.request_nodes)];
  return hasHistorySummaryNode(nodes);
}

function clampNumber(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveTriggerRatios(hs) {
  const triggerRatio = clampNumber(hs?.triggerOnContextRatio, 0.6, 0.8, 0.7);
  const targetFallback = Math.max(0.4, Math.min(0.7, triggerRatio - 0.15));
  let targetRatio = clampNumber(hs?.targetContextRatio, 0.35, 0.75, targetFallback);
  if (targetRatio >= triggerRatio) targetRatio = Math.max(0.35, triggerRatio - 0.05);
  return { triggerRatio, targetRatio };
}

function computeTriggerDecision({ hs, triggerModel, totalWithExtraBytes, convId }) {
  const triggerOnHistorySizeBytes = Number(hs.triggerOnHistorySizeChars);
  const baseDecision = { kind: "size", thresholdChars: triggerOnHistorySizeBytes, tailExcludeChars: hs.historyTailSizeCharsToExclude };
  const strategy = normalizeString(hs.triggerStrategy).toLowerCase();

  if (strategy === "chars") return totalWithExtraBytes >= triggerOnHistorySizeBytes ? baseDecision : null;

  const cwTokens = resolveContextWindowTokens(hs, triggerModel);
  if ((strategy === "ratio" || strategy === "auto") && cwTokens) {
    const approxTotalTokens = approxTokenCountFromByteLen(totalWithExtraBytes);
    const ratio = cwTokens ? approxTotalTokens / cwTokens : 0;
    const { triggerRatio, targetRatio } = resolveTriggerRatios(hs);
    if (ratio < triggerRatio) return null;
    const thresholdTokens = Math.ceil(cwTokens * triggerRatio);
    const thresholdChars = thresholdTokens * 4;
    const targetTokens = Math.floor(cwTokens * targetRatio);
    const targetCharsBudget = targetTokens * 4;
    const summaryOverhead = (Number(hs.abridgedHistoryParams?.totalCharsLimit) || 0) + (Number(hs.maxTokens) || 0) * 4 + 4096;
    const tailExcludeChars = Math.max(0, targetCharsBudget - summaryOverhead);
    debug(
      `historySummary trigger ratio: conv=${convId} model=${normalizeString(triggerModel)} tokens≈${approxTotalTokens}/${cwTokens} ratio≈${ratio.toFixed(3)} trigger=${triggerRatio} target=${targetRatio}`
    );
    return { kind: "ratio", thresholdChars, tailExcludeChars };
  }

  return totalWithExtraBytes >= triggerOnHistorySizeBytes ? baseDecision : null;
}

function buildFallbackSummaryText({ droppedHead, tail } = {}) {
  const dropped = Array.isArray(droppedHead) ? droppedHead.length : 0;
  const kept = Array.isArray(tail) ? tail.length : 0;
  return `Context was compacted without an LLM summary (dropped_exchanges=${dropped} kept_exchanges=${kept}). Use the abridged and full tail history below.`;
}

async function resolveSummaryText({
  hs,
  cfg,
  convId,
  boundaryRequestId,
  history,
  tailStart,
  droppedHead,
  fallbackProvider,
  fallbackModel,
  timeoutMs,
  abortSignal
}) {
  const now = nowMs();
  const cached = cacheGetFresh(convId, boundaryRequestId, now, hs.cacheTtlMs, { history, droppedHead });
  if (cached) return { summaryText: cached.summaryText, summarizationRequestId: cached.summarizationRequestId, now };

  const provider = pickProviderById(cfg, hs.providerId) || fallbackProvider;
  const model = normalizeString(hs.model) || normalizeString(fallbackModel);
  let prompt = asString(hs.prompt);
  let inputHistory = droppedHead.slice();

  let usedRolling = false;
  if (hs.rollingSummary === true) {
    const prev = cacheGetFreshState(convId, now, hs.cacheTtlMs, { history });
    const rollingPrompt = buildRollingUpdatePrompt(hs.prompt);
    if (
      prev &&
      normalizeString(prev.summarizedUntilRequestId) &&
      normalizeString(prev.summarizedUntilRequestId) !== boundaryRequestId
    ) {
      const prevBoundaryPos = history.findIndex(
        (h) => normalizeString(h?.request_id) === normalizeString(prev.summarizedUntilRequestId)
      );
      if (prevBoundaryPos >= 0 && prevBoundaryPos < tailStart) {
        const delta = history.slice(prevBoundaryPos, tailStart);
        if (delta.length) {
          const prevExchange = buildPrevSummaryExchange(prev.summaryText);
          inputHistory = [prevExchange, ...delta];
          usedRolling = true;
          prompt = rollingPrompt;
        }
      } else if (inputHistory.length) {
        const prevExchange = buildPrevSummaryExchange(prev.summaryText);
        inputHistory = [prevExchange, ...inputHistory];
        usedRolling = true;
        prompt = rollingPrompt;
      }
    }
  }

  const maxInBytes = Number(hs.maxSummarizationInputChars) || 0;
  if (maxInBytes > 0) {
    const shrink = () => estimateHistorySizeBytes(inputHistory) > maxInBytes;
    if (usedRolling) while (inputHistory.length > 1 && shrink()) inputHistory.splice(1, 1);
    else while (inputHistory.length && shrink()) inputHistory.shift();
  }
  if (!inputHistory.length) return null;

  const timeout = Math.min(Math.max(1000, Number(timeoutMs) || 120000), hs.timeoutSeconds * 1000);
  const summaryText = normalizeString(
    await runSummaryModelOnce({ provider, model, prompt, chatHistory: inputHistory, maxTokens: hs.maxTokens, timeoutMs: timeout, abortSignal })
  );
  if (!summaryText) return null;
  const summarizationRequestId = `byok_history_summary_${now}`;
  const tailHeadRequestIds = [];
  const tailStartIdx = Number.isFinite(Number(tailStart)) ? Math.max(0, Math.floor(Number(tailStart))) : droppedHead.length;
  for (let i = tailStartIdx; i < history.length && tailHeadRequestIds.length < DEFAULT_SUMMARY_TAIL_HEAD_REQUEST_IDS; i++) {
    const id = exchangeRequestId(history[i]);
    if (id) tailHeadRequestIds.push(id);
  }
  await cachePut(convId, boundaryRequestId, summaryText, summarizationRequestId, now, {
    startRequestId: historyStartRequestId(history),
    summarizedUntilIndex: droppedHead.length,
    summarizedRequestIdsHash: computeRequestIdsHash(droppedHead),
    summarizedTailRequestIds: tailRequestIds(droppedHead, DEFAULT_SUMMARY_TAIL_REQUEST_IDS),
    summarizedTailHeadRequestIds: tailHeadRequestIds
  });
  return { summaryText, summarizationRequestId, now };
}

function buildHistoryEnd(tail) {
  return asArray(tail).map((h) => {
    const it = asRecord(h);
    return {
      request_id: it.request_id,
      request_message: it.request_message,
      response_text: it.response_text,
      request_nodes: exchangeRequestNodes(it),
      response_nodes: exchangeResponseNodes(it)
    };
  });
}

function injectHistorySummaryNodeIntoRequestNodes({ hs, req, tail, summaryText, summarizationRequestId, abridged }) {
  const template = asString(hs.summaryNodeRequestMessageTemplate);
  const historyEnd = buildHistoryEnd(tail);
  const summaryNode = {
    summary_text: summaryText,
    summarization_request_id: summarizationRequestId,
    history_beginning_dropped_num_exchanges: abridged.droppedBeginning,
    history_middle_abridged_text: abridged.text,
    history_end: historyEnd,
    message_template: template
  };
  const node = { id: 0, type: REQUEST_NODE_HISTORY_SUMMARY, content: "", history_summary_node: summaryNode };
  const r = req && typeof req === "object" ? req : null;
  if (!r) return null;
  if (!Array.isArray(r.request_nodes)) r.request_nodes = [];
  r.request_nodes.push(node);
  return node;
}

async function maybeSummarizeAndCompactAugmentChatRequest({
  cfg,
  req,
  requestedModel,
  fallbackProvider,
  fallbackModel,
  timeoutMs,
  abortSignal
}) {
  const hs = resolveHistorySummaryConfig(cfg);
  if (!hs) return false;
  const convId = normalizeString(req?.conversation_id);
  if (!convId) return false;
  const history = asArray(req?.chat_history);
  if (!history.length) return false;
  const hasSummaryInHistory = historyContainsSummary(history);
  if (requestContainsSummary(req)) return false;

  const msg = asString(req?.message);
  const totalBytes = estimateHistorySizeBytes(history);
  const totalWithExtraBytes = totalBytes + utf8ByteLen(msg) + estimateRequestExtraSizeBytes(req);
  const triggerModel = normalizeString(requestedModel) || normalizeString(fallbackModel);
  const decision = computeTriggerDecision({ hs, triggerModel, totalWithExtraBytes, convId });

  if (decision) {
    const sel = computeTailSelection({ history, hs, decision });

    if (sel && sel.droppedHead.length) {
      const abridged = buildAbridgedHistoryText(history, hs.abridgedHistoryParams, sel.tailStart);
      const now = nowMs();
      let summary = null;
      try {
        summary = await resolveSummaryText({
          hs,
          cfg,
          convId,
          boundaryRequestId: sel.boundaryRequestId,
          history,
          tailStart: sel.tailStart,
          droppedHead: sel.droppedHead,
          fallbackProvider,
          fallbackModel,
          timeoutMs,
          abortSignal
        });
      } catch (err) {
        debug(`historySummary summarization failed (fallback): conv=${convId} err=${err instanceof Error ? err.message : String(err)}`);
        summary = null;
      }

      const summaryText = summary ? summary.summaryText : buildFallbackSummaryText({ droppedHead: sel.droppedHead, tail: sel.tail });
      const summarizationRequestId = summary ? summary.summarizationRequestId : `byok_history_summary_fallback_${now}`;

      const injected = injectHistorySummaryNodeIntoRequestNodes({
        hs,
        req,
        tail: sel.tail,
        summaryText,
        summarizationRequestId,
        abridged
      });
      if (injected) {
        debug(
          `historySummary injected: conv=${convId} kind=${summary ? "llm" : "fallback"} beforeBytes≈${totalBytes} tailStart=${sel.tailStart} refresh=${hasSummaryInHistory ? "true" : "false"}`
        );
        return true;
      }
    }
  }

  if (hasSummaryInHistory) return false;

  // 当 Augment 客户端已按轮数裁剪掉历史中的 summary exchange 时，仍然需要用缓存的 summary 补回“早期上下文”，否则会退化为仅剩最近 N 轮。
  const now = nowMs();
  const cached = hs.rollingSummary === true ? cacheGetFreshState(convId, now, hs.cacheTtlMs, { history }) : null;
  if (!cached || !normalizeString(cached.summaryText)) return false;

  const sel2 = computeTailSelection({
    history,
    hs,
    decision: { kind: "cached", thresholdChars: 0, tailExcludeChars: hs.historyTailSizeCharsToExclude }
  });
  const tail2 = sel2?.tail?.length ? sel2.tail : history;
  const abridged2 = buildAbridgedHistoryText(history, hs.abridgedHistoryParams, Number(sel2?.tailStart) || 0);
  const summarizationRequestId =
    normalizeString(cached.summarizationRequestId) || `byok_history_summary_cached_${Number(cached.updatedAtMs) || now}`;

  const injected2 = injectHistorySummaryNodeIntoRequestNodes({
    hs,
    req,
    tail: tail2,
    summaryText: cached.summaryText,
    summarizationRequestId,
    abridged: abridged2
  });
  if (!injected2) return false;

  debug(`historySummary injected from cache: conv=${convId} beforeBytes≈${totalBytes} tailStart=${Number(sel2?.tailStart) || 0}`);
  return true;
}

module.exports = { setHistorySummaryStorage, maybeSummarizeAndCompactAugmentChatRequest, deleteHistorySummaryCache, clearHistorySummaryCacheAll };
