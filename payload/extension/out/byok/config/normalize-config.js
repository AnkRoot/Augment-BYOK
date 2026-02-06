"use strict";

const { warn } = require("../infra/log");
const { normalizeEndpoint, normalizeString, normalizeStringList } = require("../infra/util");
const { defaultConfig } = require("./default-config");

const UNSAFE_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isValidHistorySummaryTemplateNewMode(template) {
  const s = normalizeString(template);
  if (!s) return false;
  const required = [
    "{summary}",
    "{summarization_request_id}",
    "{beginning_part_dropped_num_exchanges}",
    "{middle_part_abridged}",
    "{end_part_full}"
  ];
  return required.every((p) => s.includes(p));
}

function asObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

function normalizeMode(v) {
  const s = normalizeString(v);
  if (s === "byok" || s === "official" || s === "disabled") return s;
  return "";
}

function sanitizeUserJson(value, ctx) {
  const depth = ctx && typeof ctx === "object" ? Number(ctx.depth) : 0;
  const seen = ctx && typeof ctx === "object" && ctx.seen instanceof WeakMap ? ctx.seen : new WeakMap();

  if (value == null || typeof value !== "object") return value;
  if (depth >= 40) return null;
  if (seen.has(value)) return null;
  seen.set(value, true);

  if (Array.isArray(value)) return value.map((v) => sanitizeUserJson(v, { depth: depth + 1, seen }));

  const out = Object.create(null);
  for (const [k, v] of Object.entries(value)) {
    if (UNSAFE_JSON_KEYS.has(k)) continue;
    out[k] = sanitizeUserJson(v, { depth: depth + 1, seen });
  }
  return out;
}

function normalizeConfig(raw) {
  const out = defaultConfig();
  const safeRaw = sanitizeUserJson(raw, { depth: 0, seen: new WeakMap() });
  if (!safeRaw || typeof safeRaw !== "object" || Array.isArray(safeRaw)) return out;
  raw = safeRaw;

  const version = Number(raw.version);
  if (Number.isFinite(version) && version > 0) out.version = version;

  const official = asObject(raw.official);
  if (official) {
    const completionUrl = normalizeString(official.completionUrl);
    if (completionUrl) out.official.completionUrl = completionUrl;
    const apiToken = normalizeString(official.apiToken);
    if (apiToken) out.official.apiToken = apiToken;
  }

  const prompts = asObject(raw.prompts);
  if (prompts) {
    out.prompts = out.prompts && typeof out.prompts === "object" && !Array.isArray(out.prompts) ? out.prompts : {};
    out.prompts.endpointSystem =
      out.prompts.endpointSystem && typeof out.prompts.endpointSystem === "object" && !Array.isArray(out.prompts.endpointSystem)
        ? out.prompts.endpointSystem
        : {};

    const endpointSystem = asObject(prompts.endpointSystem);
    if (endpointSystem) {
      for (const [k, v] of Object.entries(endpointSystem)) {
        const ep = normalizeEndpoint(k);
        const text = normalizeString(v);
        if (!ep || !text) continue;
        out.prompts.endpointSystem[ep] = text;
      }
    }
  }

  const historySummary = asObject(raw.historySummary);
  if (historySummary) {
    const hs = out.historySummary;
    const enabled = historySummary.enabled;
    if (typeof enabled === "boolean") hs.enabled = enabled;
    const providerId = normalizeString(historySummary.providerId);
    if (providerId) hs.providerId = providerId;
    const model = normalizeString(historySummary.model);
    if (model) hs.model = model;
    const maxTokens = historySummary.maxTokens;
    if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) hs.maxTokens = Math.floor(Number(maxTokens));
    const timeoutSeconds = historySummary.timeoutSeconds;
    if (Number.isFinite(Number(timeoutSeconds)) && Number(timeoutSeconds) > 0) hs.timeoutSeconds = Math.floor(Number(timeoutSeconds));
    const triggerOnHistorySizeChars = historySummary.triggerOnHistorySizeChars;
    if (Number.isFinite(Number(triggerOnHistorySizeChars)) && Number(triggerOnHistorySizeChars) > 0)
      hs.triggerOnHistorySizeChars = Math.floor(Number(triggerOnHistorySizeChars));
    const triggerStrategy = normalizeString(historySummary.triggerStrategy);
    if (triggerStrategy) hs.triggerStrategy = triggerStrategy;
    const triggerOnContextRatio = historySummary.triggerOnContextRatio;
    if (Number.isFinite(Number(triggerOnContextRatio)) && Number(triggerOnContextRatio) > 0) hs.triggerOnContextRatio = Number(triggerOnContextRatio);
    const targetContextRatio = historySummary.targetContextRatio;
    if (Number.isFinite(Number(targetContextRatio)) && Number(targetContextRatio) > 0) hs.targetContextRatio = Number(targetContextRatio);
    const contextWindowTokensDefault = historySummary.contextWindowTokensDefault;
    if (Number.isFinite(Number(contextWindowTokensDefault)) && Number(contextWindowTokensDefault) >= 0)
      hs.contextWindowTokensDefault = Math.floor(Number(contextWindowTokensDefault));
    const contextWindowTokensOverrides = historySummary.contextWindowTokensOverrides;
    if (contextWindowTokensOverrides && typeof contextWindowTokensOverrides === "object" && !Array.isArray(contextWindowTokensOverrides))
      hs.contextWindowTokensOverrides = { ...hs.contextWindowTokensOverrides, ...contextWindowTokensOverrides };
    const historyTailSizeCharsToExclude = historySummary.historyTailSizeCharsToExclude;
    if (Number.isFinite(Number(historyTailSizeCharsToExclude)) && Number(historyTailSizeCharsToExclude) >= 0)
      hs.historyTailSizeCharsToExclude = Math.floor(Number(historyTailSizeCharsToExclude));
    const minTailExchanges = historySummary.minTailExchanges;
    if (Number.isFinite(Number(minTailExchanges)) && Number(minTailExchanges) > 0) hs.minTailExchanges = Math.floor(Number(minTailExchanges));
    const cacheTtlMs = historySummary.cacheTtlMs;
    if (Number.isFinite(Number(cacheTtlMs)) && Number(cacheTtlMs) >= 0) hs.cacheTtlMs = Math.floor(Number(cacheTtlMs));
    const maxSummarizationInputChars = historySummary.maxSummarizationInputChars;
    if (Number.isFinite(Number(maxSummarizationInputChars)) && Number(maxSummarizationInputChars) >= 0)
      hs.maxSummarizationInputChars = Math.floor(Number(maxSummarizationInputChars));
    const prompt = typeof historySummary.prompt === "string" ? historySummary.prompt : "";
    if (normalizeString(prompt)) hs.prompt = prompt;
    const rollingSummary = historySummary.rollingSummary;
    if (typeof rollingSummary === "boolean") hs.rollingSummary = rollingSummary;
    const template = typeof historySummary.summaryNodeRequestMessageTemplate === "string" ? historySummary.summaryNodeRequestMessageTemplate : "";
    if (normalizeString(template)) {
      if (!isValidHistorySummaryTemplateNewMode(template)) {
        warn(
          "historySummary.summaryNodeRequestMessageTemplate 无效（要求包含 {summary}/{summarization_request_id}/{beginning_part_dropped_num_exchanges}/{middle_part_abridged}/{end_part_full}），将使用默认模板"
        );
      } else {
        hs.summaryNodeRequestMessageTemplate = template;
      }
    }
    const abridgedHistoryParams = asObject(historySummary.abridgedHistoryParams);
    if (abridgedHistoryParams) {
      const p = hs.abridgedHistoryParams;
      const totalCharsLimit = abridgedHistoryParams.totalCharsLimit;
      if (Number.isFinite(Number(totalCharsLimit)) && Number(totalCharsLimit) > 0) p.totalCharsLimit = Math.floor(Number(totalCharsLimit));
      const userMessageCharsLimit = abridgedHistoryParams.userMessageCharsLimit;
      if (Number.isFinite(Number(userMessageCharsLimit)) && Number(userMessageCharsLimit) > 0) p.userMessageCharsLimit = Math.floor(Number(userMessageCharsLimit));
      const agentResponseCharsLimit = abridgedHistoryParams.agentResponseCharsLimit;
      if (Number.isFinite(Number(agentResponseCharsLimit)) && Number(agentResponseCharsLimit) > 0) p.agentResponseCharsLimit = Math.floor(Number(agentResponseCharsLimit));
      const actionCharsLimit = abridgedHistoryParams.actionCharsLimit;
      if (Number.isFinite(Number(actionCharsLimit)) && Number(actionCharsLimit) > 0) p.actionCharsLimit = Math.floor(Number(actionCharsLimit));
      const numFilesModifiedLimit = abridgedHistoryParams.numFilesModifiedLimit;
      if (Number.isFinite(Number(numFilesModifiedLimit)) && Number(numFilesModifiedLimit) > 0) p.numFilesModifiedLimit = Math.floor(Number(numFilesModifiedLimit));
      const numFilesCreatedLimit = abridgedHistoryParams.numFilesCreatedLimit;
      if (Number.isFinite(Number(numFilesCreatedLimit)) && Number(numFilesCreatedLimit) > 0) p.numFilesCreatedLimit = Math.floor(Number(numFilesCreatedLimit));
      const numFilesDeletedLimit = abridgedHistoryParams.numFilesDeletedLimit;
      if (Number.isFinite(Number(numFilesDeletedLimit)) && Number(numFilesDeletedLimit) > 0) p.numFilesDeletedLimit = Math.floor(Number(numFilesDeletedLimit));
      const numFilesViewedLimit = abridgedHistoryParams.numFilesViewedLimit;
      if (Number.isFinite(Number(numFilesViewedLimit)) && Number(numFilesViewedLimit) > 0) p.numFilesViewedLimit = Math.floor(Number(numFilesViewedLimit));
      const numTerminalCommandsLimit = abridgedHistoryParams.numTerminalCommandsLimit;
      if (Number.isFinite(Number(numTerminalCommandsLimit)) && Number(numTerminalCommandsLimit) > 0) p.numTerminalCommandsLimit = Math.floor(Number(numTerminalCommandsLimit));
    }
  }

  const routing = asObject(raw.routing);

  const rules = asObject(routing?.rules);
  if (rules) {
    for (const [k, v] of Object.entries(rules)) {
      const ep = normalizeEndpoint(k);
      if (!ep) continue;
      const hadDefault = Object.prototype.hasOwnProperty.call(out.routing.rules, ep);
      const r = asObject(v);
      const mode = normalizeMode(r?.mode) || "official";
      let providerId = normalizeString(r?.providerId);
      let model = normalizeString(r?.model);
      if (mode !== "byok") {
        providerId = "";
        model = "";
      }
      if (!hadDefault && mode === "official" && !providerId && !model) continue;
      out.routing.rules[ep] = { mode, providerId, model };
    }
  }

  const providers = raw.providers;
  if (Array.isArray(providers)) {
    out.providers = providers
      .map((p) => {
        const rec = asObject(p);
        if (!rec) return null;
        const id = normalizeString(rec.id);
        const type = normalizeString(rec.type);
        const baseUrl = normalizeString(rec.baseUrl);
        const apiKey = normalizeString(rec.apiKey);
        const defaultModel = normalizeString(rec.defaultModel);
        const models = normalizeStringList(rec.models, { maxItems: 10000 });
        const headers = rec.headers;
        const requestDefaults = rec.requestDefaults;
        if (!id || !type) return null;

        const finalModels = models.length ? models : defaultModel ? [defaultModel] : [];
        const finalDefaultModel = defaultModel || finalModels[0] || "";

        return {
          id,
          type,
          baseUrl,
          apiKey,
          models: finalModels,
          defaultModel: finalDefaultModel,
          headers: headers && typeof headers === "object" && !Array.isArray(headers) ? headers : {},
          requestDefaults: requestDefaults && typeof requestDefaults === "object" && !Array.isArray(requestDefaults) ? requestDefaults : {}
        };
      })
      .filter(Boolean);
  }

  return out;
}

module.exports = { normalizeConfig };
