"use strict";

const { normalizeString } = require("../../../infra/util");
const shared = require("../../augment-chat/shared");
const { inferContextWindowTokensFromModelName } = require("../../token-budget/context-window");

const { asRecord } = shared;

function resolveContextWindowTokens(hs, requestedModel) {
  const model = normalizeString(requestedModel).toLowerCase();
  if (!model) return null;
  const overrides = asRecord(hs?.contextWindowTokensOverrides);
  const keys = Object.keys(overrides).sort((a, b) => String(b).length - String(a).length);
  for (const k of keys) {
    const key = normalizeString(k).toLowerCase();
    const v = Number(overrides[k]);
    if (!key || !Number.isFinite(v) || v <= 0) continue;
    if (model.includes(key)) return Math.floor(v);
  }
  const d = Number(hs?.contextWindowTokensDefault);
  if (Number.isFinite(d) && d > 0) return Math.floor(d);
  return inferContextWindowTokensFromModelName(model);
}

function resolveHistorySummaryConfig(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const hs =
    c.historySummary && typeof c.historySummary === "object" && !Array.isArray(c.historySummary) ? c.historySummary : null;
  if (!hs) return null;
  if (hs.enabled !== true) return null;
  const triggerOnHistorySizeChars = Number(hs.triggerOnHistorySizeChars);
  const maxTokens = Number(hs.maxTokens);
  const minTailExchanges = Number(hs.minTailExchanges);
  const tChars = Number.isFinite(triggerOnHistorySizeChars) && triggerOnHistorySizeChars > 0 ? Math.floor(triggerOnHistorySizeChars) : 0;
  if (!tChars) return null;
  return {
    ...hs,
    triggerOnHistorySizeChars: tChars,
    historyTailSizeCharsToExclude: Math.max(0, Math.floor(Number(hs.historyTailSizeCharsToExclude) || 0)),
    minTailExchanges: Number.isFinite(minTailExchanges) && minTailExchanges > 0 ? Math.floor(minTailExchanges) : 2,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 1024,
    timeoutSeconds: Math.max(1, Math.floor(Number(hs.timeoutSeconds) || 60)),
    cacheTtlMs: Math.max(0, Math.floor(Number(hs.cacheTtlMs) || 0)),
    maxSummarizationInputChars: Math.max(0, Math.floor(Number(hs.maxSummarizationInputChars) || 0)),
    triggerStrategy: normalizeString(hs.triggerStrategy) || "auto",
    triggerOnContextRatio: Number(hs.triggerOnContextRatio) || 0.7,
    targetContextRatio: Number(hs.targetContextRatio) || 0.55,
    prompt: typeof hs.prompt === "string" ? hs.prompt : "",
    abridgedHistoryParams: asRecord(hs.abridgedHistoryParams)
  };
}

function pickProviderById(cfg, providerId) {
  const pid = normalizeString(providerId);
  const list = Array.isArray(cfg?.providers) ? cfg.providers : [];
  if (!pid) return null;
  return list.find((p) => p && normalizeString(p.id) === pid) || null;
}

module.exports = { resolveContextWindowTokens, resolveHistorySummaryConfig, pickProviderById };
