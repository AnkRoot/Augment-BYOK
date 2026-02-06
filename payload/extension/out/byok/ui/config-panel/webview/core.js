(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const ns = window.__byokCfgPanel;
  if (!ns || typeof ns.qs !== "function" || typeof ns.renderApp !== "function" || typeof ns.parseByokModelId !== "function") {
    throw new Error("BYOK panel init failed (missing util/render)");
  }

  const { qs, normalizeStr, uniq, renderApp, debugLog, withTiming, parseByokModelId } = ns;
  const dom = ns.__byokCfgPanelDom;
  if (
    !dom ||
    typeof dom.applyProvidersEditsFromDom !== "function" ||
    typeof dom.applyRulesEditsFromDom !== "function" ||
    typeof dom.applyPromptsEditsFromDom !== "function" ||
    typeof dom.gatherSelfTestProviderKeysFromDom !== "function"
  ) {
    throw new Error("BYOK panel init failed (missing dom helpers)");
  }

  function summarizeMessageForLog(msg) {
    const t = msg && typeof msg === "object" ? normalizeStr(msg.type) : "";
    const idxRaw = msg && typeof msg === "object" && "idx" in msg ? Number(msg.idx) : NaN;
    const requestId = msg && typeof msg === "object" ? normalizeStr(msg.requestId) : "";
    const out = { type: t || "(unknown)" };
    if (Number.isFinite(idxRaw)) out.idx = idxRaw;
    if (requestId) out.requestId = requestId;
    return out;
  }

  function postToExtension(msg) {
    const summary = summarizeMessageForLog(msg);
    debugLog("postMessage", summary);
    try {
      vscode.postMessage(msg);
    } catch (err) {
      debugLog("postMessage FAIL", { ...summary, err: err instanceof Error ? err.message : String(err) });
    }
  }

  function getPersistedState() {
    try {
      return vscode && typeof vscode.getState === "function" ? vscode.getState() : null;
    } catch {
      return null;
    }
  }

  function setPersistedState(patch) {
    try {
      if (!vscode || typeof vscode.setState !== "function") return;
      const prev = getPersistedState();
      const next = { ...(prev && typeof prev === "object" ? prev : {}), ...(patch && typeof patch === "object" ? patch : {}) };
      vscode.setState(next);
    } catch {}
  }

  const persisted = getPersistedState();
  const persistedEndpointSearch = persisted && typeof persisted === "object" ? normalizeStr(persisted.endpointSearch) : "";
  const persistedProviderExpanded =
    persisted && typeof persisted === "object" && persisted.providerExpanded && typeof persisted.providerExpanded === "object" && !Array.isArray(persisted.providerExpanded)
      ? persisted.providerExpanded
      : {};
  const persistedSelfTestProviderKeys =
    persisted && typeof persisted === "object" && Array.isArray(persisted.selfTestProviderKeys)
      ? uniq(persisted.selfTestProviderKeys.map((k) => normalizeStr(k)).filter(Boolean))
      : [];

  let uiState = {
    cfg: {},
    runtimeEnabled: false,
    status: "Ready.",
    clearOfficialToken: false,
    officialTest: { running: false, ok: null, text: "" },
    providerExpanded: persistedProviderExpanded,
    modal: null,
    dirty: false,
    selfTest: { running: false, logs: [], report: null },
    selfTestProviderKeys: persistedSelfTestProviderKeys,
    endpointSearch: persistedEndpointSearch
  };

  function updateDirtyBadge() {
    const el = qs("#dirtyBadge");
    if (!el) return;
    el.textContent = uiState.dirty ? "pending" : "saved";
    try {
      el.classList.toggle("status-badge--warning", uiState.dirty);
      el.classList.toggle("status-badge--success", !uiState.dirty);
    } catch {}
  }

  function updateStatusText(text) {
    const el = qs("#status");
    if (!el) return;
    el.textContent = String(text ?? "");
  }

  function markDirty(statusText) {
    if (!uiState.dirty) uiState.dirty = true;
    if (statusText) uiState.status = String(statusText);
    updateDirtyBadge();
    if (statusText) updateStatusText(statusText);
  }

  function applyEndpointFilter() {
    return withTiming(
      "applyEndpointFilter",
      () => {
        const inputEl = qs("#endpointSearch");
        const raw = inputEl ? normalizeStr(inputEl.value) : normalizeStr(uiState.endpointSearch);
        const q = raw.toLowerCase();

        const rows = Array.from(document.querySelectorAll("[data-endpoint-row]"));
        let visible = 0;
        for (const row of rows) {
          const ep = normalizeStr(row.getAttribute("data-endpoint-row"));
          const desc = normalizeStr(row.getAttribute("data-endpoint-desc"));
          const hay = `${ep} ${desc}`.toLowerCase();
          const match = !q || hay.includes(q);
          row.hidden = !match;
          if (match) visible += 1;
        }

        const groups = Array.from(document.querySelectorAll("[data-endpoint-group]"));
        for (const g of groups) {
          const items = Array.from(g.querySelectorAll("[data-endpoint-row]"));
          const totalInGroup = items.length;
          const visibleInGroup = items.reduce((n, el) => (el && !el.hidden ? n + 1 : n), 0);
          const anyVisible = visibleInGroup > 0;
          g.hidden = !anyVisible;
          if (q && anyVisible && typeof g.open === "boolean") g.open = true;

          const badge = g.querySelector ? g.querySelector("[data-endpoint-group-count-badge]") : null;
          if (badge) badge.textContent = q ? `显示 ${visibleInGroup} / ${totalInGroup}` : `${totalInGroup} total`;
        }

        const countEl = qs("#endpointFilterCount");
        if (countEl) countEl.textContent = rows.length ? `显示 ${visible} / ${rows.length}` : "";
      },
      { thresholdMs: 16 }
    );
  }

  function setEndpointSearch(next) {
    uiState.endpointSearch = normalizeStr(next);
    setPersistedState({ endpointSearch: uiState.endpointSearch });
    applyEndpointFilter();
  }

  function render() {
    return withTiming(
      "render",
      () => {
        const app = qs("#app");
        if (app) app.innerHTML = renderApp(uiState);

        applyEndpointFilter();
      },
      { thresholdMs: 32 }
    );
  }

  function gatherConfigFromDom() {
    return withTiming(
      "gatherConfigFromDom",
      () => {
        const base = uiState.cfg && typeof uiState.cfg === "object" ? uiState.cfg : {};
        const cfg = JSON.parse(JSON.stringify(base));

        cfg.historySummary = cfg.historySummary && typeof cfg.historySummary === "object" ? cfg.historySummary : {};
        cfg.historySummary.enabled = Boolean(qs("#historySummaryEnabled")?.checked);
        cfg.historySummary.providerId = "";
        cfg.historySummary.model = "";
        const hsByokModel = normalizeStr(qs("#historySummaryByokModel")?.value);
        const parsedHsModel = parseByokModelId(hsByokModel);
        if (parsedHsModel) {
          cfg.historySummary.providerId = parsedHsModel.providerId;
          cfg.historySummary.model = parsedHsModel.modelId;
        }
        const hsPrompt = qs("#historySummaryPrompt");
        if (hsPrompt) cfg.historySummary.prompt = normalizeStr(hsPrompt.value);
        const setOptionalInt = (selector, key, { min = 0 } = {}) => {
          const raw = normalizeStr(qs(selector)?.value);
          if (!raw) {
            delete cfg.historySummary[key];
            return;
          }
          const n = Number(raw);
          if (!Number.isFinite(n)) return;
          const v = Math.floor(n);
          if (v < Number(min)) return;
          cfg.historySummary[key] = v;
        };
        const setOptionalNumber = (selector, key, { min = 0, max = Number.POSITIVE_INFINITY } = {}) => {
          const raw = normalizeStr(qs(selector)?.value);
          if (!raw) {
            delete cfg.historySummary[key];
            return;
          }
          const n = Number(raw);
          if (!Number.isFinite(n)) return;
          if (n < Number(min) || n > Number(max)) return;
          cfg.historySummary[key] = n;
        };
        const hsTriggerStrategy = normalizeStr(qs("#historySummaryTriggerStrategy")?.value).toLowerCase();
        if (hsTriggerStrategy) cfg.historySummary.triggerStrategy = hsTriggerStrategy;
        setOptionalInt("#historySummaryTriggerOnHistorySizeChars", "triggerOnHistorySizeChars", { min: 1 });
        setOptionalNumber("#historySummaryTriggerOnContextRatio", "triggerOnContextRatio", { min: 0.1, max: 0.95 });
        setOptionalNumber("#historySummaryTargetContextRatio", "targetContextRatio", { min: 0.1, max: 0.95 });
        setOptionalInt("#historySummaryHistoryTailSizeCharsToExclude", "historyTailSizeCharsToExclude", { min: 0 });
        setOptionalInt("#historySummaryMinTailExchanges", "minTailExchanges", { min: 1 });
        setOptionalInt("#historySummaryMaxTokens", "maxTokens", { min: 1 });
        setOptionalInt("#historySummaryTimeoutSeconds", "timeoutSeconds", { min: 1 });
        setOptionalInt("#historySummaryCacheTtlMs", "cacheTtlMs", { min: 0 });
        setOptionalInt("#historySummaryMaxSummarizationInputChars", "maxSummarizationInputChars", { min: 0 });
        setOptionalInt("#historySummaryContextWindowTokensDefault", "contextWindowTokensDefault", { min: 0 });
        const hsRollingSummary = qs("#historySummaryRollingSummary");
        if (hsRollingSummary) cfg.historySummary.rollingSummary = Boolean(hsRollingSummary.checked);
        const hsContextWindowOverridesRaw = normalizeStr(qs("#historySummaryContextWindowTokensOverrides")?.value);
        if (!hsContextWindowOverridesRaw) {
          delete cfg.historySummary.contextWindowTokensOverrides;
        } else {
          try {
            const parsed = JSON.parse(hsContextWindowOverridesRaw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cfg.historySummary.contextWindowTokensOverrides = parsed;
          } catch {}
        }

        cfg.routing = cfg.routing && typeof cfg.routing === "object" ? cfg.routing : {};

        cfg.official = cfg.official && typeof cfg.official === "object" ? cfg.official : {};
        cfg.official.completionUrl = normalizeStr(qs("#officialCompletionUrl")?.value);

        const officialTokenInput = normalizeStr(qs("#officialApiToken")?.value);
        if (officialTokenInput) cfg.official.apiToken = officialTokenInput;
        if (uiState.clearOfficialToken) cfg.official.apiToken = "";

        dom.applyProvidersEditsFromDom(cfg);
        dom.applyRulesEditsFromDom(cfg);
        dom.applyPromptsEditsFromDom(cfg);

        cfg.routing = cfg.routing && typeof cfg.routing === "object" ? cfg.routing : {};
        cfg.routing.rules = cfg.routing.rules && typeof cfg.routing.rules === "object" ? cfg.routing.rules : {};
        for (const ep of Object.keys(cfg.routing.rules)) {
          const r = cfg.routing.rules[ep] && typeof cfg.routing.rules[ep] === "object" ? cfg.routing.rules[ep] : null;
          const mode = normalizeStr(r?.mode);
          if (!r || !mode) {
            delete cfg.routing.rules[ep];
            continue;
          }
          if (mode !== "byok") {
            r.providerId = "";
            r.model = "";
          }
        }

        return cfg;
      },
      { thresholdMs: 16 }
    );
  }

  function setUiState(patch, { preserveEdits = true } = {}) {
    if (preserveEdits) {
      try {
        if (qs("#officialCompletionUrl")) uiState.cfg = gatherConfigFromDom();
      } catch {}
    }
    uiState = { ...uiState, ...(patch || {}) };
    render();
  }

  ns.__byokCfgPanelCore = {
    vscode,
    getUiState: () => uiState,
    setUiState,
    markDirty,
    setEndpointSearch,
    applyEndpointFilter,
    gatherConfigFromDom,
    gatherSelfTestProviderKeysFromDom: dom.gatherSelfTestProviderKeysFromDom,
    postToExtension,
    summarizeMessageForLog,
    getPersistedState,
    setPersistedState,
    parseByokModelId
  };
})();
