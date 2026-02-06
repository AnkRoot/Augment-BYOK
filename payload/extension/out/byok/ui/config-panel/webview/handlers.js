(function () {
  "use strict";

  const ns = window.__byokCfgPanel;
  const core = ns && typeof ns === "object" ? ns.__byokCfgPanelCore : null;
  if (!ns || typeof ns.qs !== "function" || !core || typeof core.setUiState !== "function") throw new Error("BYOK panel init failed (missing core)");

  const { qs, normalizeStr, uniq, parseModelsTextarea, parseJsonOrEmptyObject, debugLog, newRequestId, defaultBaseUrlForProviderType } = ns;
  const {
    getUiState,
    setUiState,
    markDirty,
    setEndpointSearch,
    gatherConfigFromDom,
    gatherSelfTestProviderKeysFromDom,
    postToExtension,
    summarizeMessageForLog,
    setPersistedState
  } = core;

  function coerceSelfTestState(v) {
    const st = v && typeof v === "object" ? v : {};
    return {
      running: Boolean(st.running),
      logs: Array.isArray(st.logs) ? st.logs : [],
      report: st.report || null
    };
  }

  function getSelfTestState() {
    return coerceSelfTestState(getUiState()?.selfTest);
  }

  function handleMessage(msg) {
    const t = msg && typeof msg === "object" ? msg.type : "";
    if (t && t !== "selfTestLog" && t !== "status") debugLog("onMessage", summarizeMessageForLog(msg));

    if (t === "status") {
      setUiState({ status: msg.status || "" }, { preserveEdits: true });
      return;
    }
    if (t === "render") {
      setUiState({ cfg: msg.config || {}, runtimeEnabled: msg.runtimeEnabled === true, clearOfficialToken: false, modal: null, dirty: false }, { preserveEdits: false });
      return;
    }
    if (t === "providerModelsFetched") {
      const idx = Number(msg.idx);
      const models = Array.isArray(msg.models) ? msg.models : [];
      const cfg = gatherConfigFromDom();
      cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
      if (!Number.isFinite(idx) || idx < 0 || idx >= cfg.providers.length)
        return setUiState({ status: "Models fetched but provider index invalid." }, { preserveEdits: true });
      cfg.providers[idx] = cfg.providers[idx] && typeof cfg.providers[idx] === "object" ? cfg.providers[idx] : {};
      cfg.providers[idx].models = uniq(models);
      const dm = normalizeStr(cfg.providers[idx].defaultModel);
      if (dm && !cfg.providers[idx].models.includes(dm)) cfg.providers[idx].models = uniq(cfg.providers[idx].models.concat([dm]));
      if (!dm) cfg.providers[idx].defaultModel = cfg.providers[idx].models[0] || "";
      return setUiState({ cfg, status: "Models fetched (pending save).", dirty: true }, { preserveEdits: false });
    }
    if (t === "providerModelsFailed") return setUiState({ status: msg.error || "Fetch models failed." }, { preserveEdits: true });
    if (t === "selfTestStarted") return setUiState({ selfTest: { running: true, logs: [], report: null }, status: "Self Test started..." }, { preserveEdits: true });
    if (t === "selfTestLog") {
      const line = normalizeStr(msg?.line);
      const prev = getSelfTestState();
      const logs = prev.logs.slice();
      if (line) logs.push(line);
      while (logs.length > 600) logs.shift();
      return setUiState({ selfTest: { ...prev, logs } }, { preserveEdits: true });
    }
    if (t === "selfTestDone") {
      const prev = getSelfTestState();
      return setUiState({ selfTest: { ...prev, running: false, report: msg?.report || null }, status: "Self Test finished." }, { preserveEdits: true });
    }
    if (t === "selfTestFailed") {
      const prev = getSelfTestState();
      const err = normalizeStr(msg?.error);
      return setUiState(
        { selfTest: { ...prev, running: false }, status: err ? `Self Test failed: ${err}` : "Self Test failed." },
        { preserveEdits: true }
      );
    }
    if (t === "selfTestCanceled") {
      const prev = getSelfTestState();
      return setUiState({ selfTest: { ...prev, running: false }, status: "Self Test canceled." }, { preserveEdits: true });
    }
    if (t === "officialGetModelsOk") {
      const modelsCount = Number.isFinite(Number(msg?.modelsCount)) ? Number(msg.modelsCount) : 0;
      const defaultModel = normalizeStr(msg?.defaultModel);
      const featureFlagsCount = Number.isFinite(Number(msg?.featureFlagsCount)) ? Number(msg.featureFlagsCount) : 0;
      const elapsedMs = Number.isFinite(Number(msg?.elapsedMs)) ? Math.max(0, Math.floor(Number(msg.elapsedMs))) : 0;
      const parts = [`models=${modelsCount}`];
      if (defaultModel) parts.push(`default=${defaultModel}`);
      if (featureFlagsCount) parts.push(`flags=${featureFlagsCount}`);
      if (elapsedMs) parts.push(`${elapsedMs}ms`);
      const text = parts.join(" ");
      return setUiState({ status: "Official /get-models OK.", officialTest: { running: false, ok: true, text } }, { preserveEdits: true });
    }
    if (t === "officialGetModelsFailed") {
      let err = normalizeStr(msg?.error) || "Official /get-models failed.";
      err = err.replace(/^Official\s+\/get-models\s+failed:\s*/i, "");
      return setUiState({ status: "Official /get-models failed.", officialTest: { running: false, ok: false, text: err } }, { preserveEdits: true });
    }
  }

  window.addEventListener("message", (ev) => handleMessage(ev.data));

	  function handleAction(action, btn) {
	    const a = normalizeStr(action);
	    if (!a) return;
    const idxForLog = btn && typeof btn.getAttribute === "function" ? Number(btn.getAttribute("data-idx")) : NaN;
    if (Number.isFinite(idxForLog)) debugLog("action", { action: a, idx: idxForLog });
    else debugLog("action", { action: a });
    if (a === "toggleProviderCard") {
      const card = btn && btn.closest ? btn.closest("[data-provider-card]") : null;
      if (!card) return;
      card.classList.toggle("is-expanded");
      const key = normalizeStr(card.getAttribute("data-provider-key"));
      if (key) {
        const st = getUiState();
        const next = st.providerExpanded && typeof st.providerExpanded === "object" ? { ...st.providerExpanded } : {};
        next[key] = card.classList.contains("is-expanded");
        st.providerExpanded = next;
        setPersistedState({ providerExpanded: next });
      }
      return;
    }
    if (a === "clearOfficialToken") return setUiState({ clearOfficialToken: true, status: "Official token cleared (pending save).", dirty: true }, { preserveEdits: true });
    if (a === "fetchProviderModels") {
      const idx = btn && typeof btn.getAttribute === "function" ? Number(btn.getAttribute("data-idx")) : NaN;
      const cfg = gatherConfigFromDom();
      cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
      const p = Number.isFinite(idx) && idx >= 0 && idx < cfg.providers.length ? cfg.providers[idx] : null;
      if (!p) return setUiState({ status: "Fetch Models: provider not found." }, { preserveEdits: true });
      const requestId = newRequestId("fetchModels");
      postToExtension({ type: "fetchProviderModels", requestId, idx, provider: p });
      return setUiState({ status: `Fetching models... (Provider #${idx + 1})` }, { preserveEdits: true });
    }
    if (a === "testOfficialGetModels") {
      const requestId = newRequestId("officialGetModels");
      postToExtension({ type: "testOfficialGetModels", requestId, config: gatherConfigFromDom() });
      return setUiState({ status: "Testing Official /get-models...", officialTest: { running: true, ok: null, text: "" } }, { preserveEdits: true });
    }
    if (a === "runSelfTest") {
      const requestId = newRequestId("selfTest");
      postToExtension({ type: "runSelfTest", requestId, config: gatherConfigFromDom(), providerKeys: gatherSelfTestProviderKeysFromDom() });
      return setUiState({ selfTest: { running: true, logs: [], report: null }, status: "Self Test starting..." }, { preserveEdits: true });
    }
    if (a === "cancelSelfTest") {
      postToExtension({ type: "cancelSelfTest" });
      return setUiState({ status: "Canceling Self Test..." }, { preserveEdits: true });
    }
    if (a === "clearSelfTest") return setUiState({ selfTest: { running: false, logs: [], report: null }, status: "Self Test cleared." }, { preserveEdits: true });
    if (a === "selfTestSelectAllProviders") {
      const cfg = gatherConfigFromDom();
      const providers = Array.isArray(cfg.providers) ? cfg.providers : [];
      const keys = uniq(providers.map((p, idx) => normalizeStr(p?.id) || `idx:${idx}`).filter(Boolean));
      setPersistedState({ selfTestProviderKeys: keys });
      return setUiState({ selfTestProviderKeys: keys, status: "Self Test providers: 全选。" }, { preserveEdits: true });
    }
    if (a === "selfTestClearSelectedProviders") {
      setPersistedState({ selfTestProviderKeys: [] });
      return setUiState({ selfTestProviderKeys: [], status: "Self Test providers: 已清空（=全部）。" }, { preserveEdits: true });
    }
    if (a === "editProviderModels") return setUiState({ modal: { kind: "models", idx: Number(btn.getAttribute("data-idx")) } }, { preserveEdits: true });
    if (a === "editProviderHeaders") return setUiState({ modal: { kind: "headers", idx: Number(btn.getAttribute("data-idx")) } }, { preserveEdits: true });
    if (a === "editProviderRequestDefaults") return setUiState({ modal: { kind: "requestDefaults", idx: Number(btn.getAttribute("data-idx")) } }, { preserveEdits: true });
    if (a === "modalCancel") return setUiState({ modal: null, status: "Canceled." }, { preserveEdits: true });
    if (a === "confirmReset") {
      postToExtension({ type: "reset" });
      return setUiState({ modal: null, status: "Resetting..." }, { preserveEdits: true });
    }
    if (a === "modalApply") {
      const st = getUiState();
      const m = st.modal && typeof st.modal === "object" ? st.modal : null;
      const idx = Number(m?.idx);
      const kind = normalizeStr(m?.kind);
      const text = qs("#modalText")?.value ?? "";
      const cfg = gatherConfigFromDom();
      cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
      if (!Number.isFinite(idx) || idx < 0 || idx >= cfg.providers.length)
        return setUiState({ status: "Apply failed: provider index invalid." }, { preserveEdits: true });
      const p = cfg.providers[idx] && typeof cfg.providers[idx] === "object" ? cfg.providers[idx] : (cfg.providers[idx] = {});
      if (kind === "models") p.models = parseModelsTextarea(text);
      else {
        try {
          kind === "headers" ? (p.headers = parseJsonOrEmptyObject(text)) : (p.requestDefaults = parseJsonOrEmptyObject(text));
        } catch {
          return setUiState({ status: "Invalid JSON (kept modal open)." }, { preserveEdits: true });
        }
      }
      return setUiState({ cfg, modal: null, status: "Updated (pending save).", dirty: true }, { preserveEdits: false });
    }
    if (a === "addProvider") {
      const cfg = gatherConfigFromDom();
      cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
      cfg.providers.push({
        id: `provider_${cfg.providers.length + 1}`,
        type: "openai_compatible",
        baseUrl: normalizeStr(typeof defaultBaseUrlForProviderType === "function" ? defaultBaseUrlForProviderType("openai_compatible") : ""),
        apiKey: "",
        models: [],
        defaultModel: "",
        headers: {},
        requestDefaults: {}
      });
      return setUiState({ cfg, status: "Provider added (pending save).", dirty: true }, { preserveEdits: false });
    }
    if (a === "removeProvider") {
      const idx = btn && typeof btn.getAttribute === "function" ? Number(btn.getAttribute("data-idx")) : NaN;
      const cfg = gatherConfigFromDom();
      cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
      if (Number.isFinite(idx) && idx >= 0 && idx < cfg.providers.length) cfg.providers.splice(idx, 1);
      return setUiState({ cfg, status: "Provider removed (pending save).", dirty: true }, { preserveEdits: false });
    }
    if (a === "makeProviderDefault") {
      const idx = btn && typeof btn.getAttribute === "function" ? Number(btn.getAttribute("data-idx")) : NaN;
      const cfg = gatherConfigFromDom();
      cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
      if (!Number.isFinite(idx) || idx <= 0 || idx >= cfg.providers.length)
        return setUiState({ status: "Make Default: provider index invalid." }, { preserveEdits: true });
      const [picked] = cfg.providers.splice(idx, 1);
      cfg.providers.unshift(picked);
      return setUiState({ cfg, status: "Default provider updated (providers[0], pending save).", dirty: true }, { preserveEdits: false });
    }
    if (a === "clearProviderKey") {
      const idx = btn && typeof btn.getAttribute === "function" ? Number(btn.getAttribute("data-idx")) : NaN;
      const cfg = gatherConfigFromDom();
      cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
      if (cfg.providers[idx]) cfg.providers[idx].apiKey = "";
      return setUiState({ cfg, status: "Provider apiKey cleared (pending save).", dirty: true }, { preserveEdits: false });
    }
    if (a === "setProviderBaseUrlDefault") {
      const idx = btn && typeof btn.getAttribute === "function" ? Number(btn.getAttribute("data-idx")) : NaN;
      const cfg = gatherConfigFromDom();
      cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
      const p = cfg.providers[idx] && typeof cfg.providers[idx] === "object" ? cfg.providers[idx] : null;
      if (!p) return setUiState({ status: "Set default Base URL: provider index invalid." }, { preserveEdits: true });
      const t = normalizeStr(p.type);
      const d = normalizeStr(typeof defaultBaseUrlForProviderType === "function" ? defaultBaseUrlForProviderType(t) : "");
      if (!d) return setUiState({ status: `Set default Base URL: unknown provider.type=${t || "(empty)"}` }, { preserveEdits: true });
      p.baseUrl = d;
      return setUiState({ cfg, status: "Provider baseUrl set to default (pending save).", dirty: true }, { preserveEdits: false });
    }

    if (typeof ns.handlePromptsAction === "function" && ns.handlePromptsAction({ action: a, gatherConfigFromDom, setUiState })) return;

    if (a === "save") {
      postToExtension({ type: "save", config: gatherConfigFromDom() });
      return setUiState({ status: "Saving..." }, { preserveEdits: true });
    }
    if (a === "exportConfig") {
      postToExtension({ type: "exportConfig", config: gatherConfigFromDom() });
      return setUiState({ status: "Exporting..." }, { preserveEdits: true });
    }
    if (a === "importConfig") {
      postToExtension({ type: "importConfig", dirty: Boolean(getUiState()?.dirty) });
      return setUiState({ status: "Importing..." }, { preserveEdits: true });
    }
    if (a === "clearHistorySummaryCache") {
      postToExtension({ type: "clearHistorySummaryCache" });
      return setUiState({ status: "Clearing history summary cache..." }, { preserveEdits: true });
    }
    if (a === "reset") return setUiState({ modal: { kind: "confirmReset" } }, { preserveEdits: true });
    if (a === "reload") {
      postToExtension({ type: "reload" });
      return setUiState({ status: "Reloading..." }, { preserveEdits: true });
    }
    if (a === "reloadWindow") {
      postToExtension({ type: "reloadWindow" });
      return setUiState({ status: "Reload Window requested..." }, { preserveEdits: true });
    }
    debugLog("action.unknown", { action: a });
  }

  document.addEventListener("click", (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest("[data-action]") : null;
    if (btn) handleAction(btn.getAttribute("data-action"), btn);
  });

  function handleRuleChange(el) {
    const ep = normalizeStr(el.getAttribute("data-rule-ep"));
    const key = normalizeStr(el.getAttribute("data-rule-key"));
    const cfg = gatherConfigFromDom();
    cfg.routing = cfg.routing && typeof cfg.routing === "object" ? cfg.routing : {};
    cfg.routing.rules = cfg.routing.rules && typeof cfg.routing.rules === "object" ? cfg.routing.rules : {};

    if (key === "mode") {
      const nextMode = normalizeStr(el.value);
      if (!nextMode) {
        if (cfg.routing.rules[ep]) delete cfg.routing.rules[ep];
        return setUiState({ cfg, status: `Rule cleared: ${ep} (use default, pending save).`, dirty: true }, { preserveEdits: false });
      }
      const r = cfg.routing.rules[ep] && typeof cfg.routing.rules[ep] === "object" ? cfg.routing.rules[ep] : (cfg.routing.rules[ep] = {});
      r.mode = nextMode;
      if (nextMode !== "byok") {
        r.providerId = "";
        r.model = "";
      }
      return setUiState({ cfg, status: `Rule mode changed: ${ep} (pending save).`, dirty: true }, { preserveEdits: false });
    }

    if (key === "providerId") {
      const r = cfg.routing.rules[ep] && typeof cfg.routing.rules[ep] === "object" ? cfg.routing.rules[ep] : (cfg.routing.rules[ep] = {});
      r.mode = "byok";
      const pid = normalizeStr(r.providerId);
      if (!pid) {
        r.model = "";
      } else {
        const ps = Array.isArray(cfg.providers) ? cfg.providers : [];
        const p = ps.find((x) => normalizeStr(x?.id) === pid);
        const models = Array.isArray(p?.models) ? p.models.map((m) => normalizeStr(m)).filter(Boolean) : [];
        const m = normalizeStr(r.model);
        if (m && models.length && !models.includes(m)) r.model = "";
      }
      return setUiState({ cfg, status: `Rule provider changed: ${ep} (pending save).`, dirty: true }, { preserveEdits: false });
    }

    if (key === "model") {
      const r = cfg.routing.rules[ep] && typeof cfg.routing.rules[ep] === "object" ? cfg.routing.rules[ep] : (cfg.routing.rules[ep] = {});
      r.mode = "byok";
      return setUiState({ cfg, status: `Rule model changed: ${ep} (pending save).`, dirty: true }, { preserveEdits: false });
    }

    return setUiState({ cfg, status: `Rule updated: ${ep} (pending save).`, dirty: true }, { preserveEdits: false });
  }

  function handleChange(el) {
    if (!el || typeof el.matches !== "function") return;
    if (el.matches("input[type=\"checkbox\"][data-selftest-provider-key]")) {
      const keys = gatherSelfTestProviderKeysFromDom();
      setPersistedState({ selfTestProviderKeys: keys });
      return setUiState({ selfTestProviderKeys: keys }, { preserveEdits: true });
    }
    if (el.matches("#runtimeEnabledToggle")) {
      const enable = Boolean(el.checked);
      postToExtension({ type: enable ? "enableRuntime" : "disableRuntime" });
      return setUiState({ status: enable ? "Enabling runtime..." : "Disabling runtime..." }, { preserveEdits: true });
    }

    if (el.matches("[data-rule-ep][data-rule-key]")) return handleRuleChange(el);
    if (el.matches("[data-p-key=\"type\"]")) {
      const idx = Number(el.getAttribute("data-p-idx"));
      const nextType = normalizeStr(el.value);
      const cfg = gatherConfigFromDom();
      cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
      const p =
        Number.isFinite(idx) && idx >= 0 && idx < cfg.providers.length && cfg.providers[idx] && typeof cfg.providers[idx] === "object"
          ? cfg.providers[idx]
          : null;
      if (!p) return setUiState({ status: "Provider type changed but provider index invalid." }, { preserveEdits: true });
      if (!normalizeStr(p.baseUrl)) {
        const d = normalizeStr(typeof defaultBaseUrlForProviderType === "function" ? defaultBaseUrlForProviderType(nextType) : "");
        if (d) {
          p.baseUrl = d;
          return setUiState({ cfg, status: "Provider type changed: baseUrl set to default (pending save).", dirty: true }, { preserveEdits: false });
        }
      }
      return setUiState({ cfg, status: "Provider updated (pending save).", dirty: true }, { preserveEdits: false });
    }

    if (el.matches("[data-p-key=\"defaultModel\"],[data-p-key=\"thinkingLevel\"]")) return setUiState({ status: "Provider updated (pending save).", dirty: true }, { preserveEdits: true });
    if (el.matches("#historySummaryEnabled,#historySummaryByokModel,#historySummaryRollingSummary,#historySummaryTriggerStrategy"))
      return markDirty("History summary updated (pending save).");
  }

  function handleInput(el) {
    if (!el || typeof el.matches !== "function") return;
    if (el.matches("#endpointSearch")) return setEndpointSearch(el.value);
    if (el.matches("#modalText")) return;

    // providers: live validation (avoid full rerender on every keystroke)
    if (el.matches("input[data-p-key=\"id\"],input[data-p-key=\"baseUrl\"]")) {
      const idx = Number(el.getAttribute("data-p-idx"));
      const key = el.getAttribute("data-p-key");
      try {
        if (ns && typeof ns.updateProviderFieldValidationFromDom === "function") ns.updateProviderFieldValidationFromDom(idx, key);
      } catch {}
      return markDirty("Edited (pending save).");
    }

    if (el.matches("input[type=\"text\"],input[type=\"number\"],input[type=\"password\"],input[type=\"url\"],textarea")) return markDirty("Edited (pending save).");
  }

  document.addEventListener("change", (ev) => handleChange(ev.target));
  document.addEventListener("input", (ev) => handleInput(ev.target));
})();
