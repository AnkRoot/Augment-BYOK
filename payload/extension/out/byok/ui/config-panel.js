"use strict";

const { info, warn } = require("../infra/log");
const { normalizeString, normalizeRawToken } = require("../infra/util");
const { defaultConfig } = require("../config/config");
const { setRuntimeEnabled: setRuntimeEnabledPersisted } = require("../config/state");
const { clearHistorySummaryCacheAll } = require("../core/augment-history-summary-auto");
const { runSelfTest } = require("../core/self-test");
const { fetchProviderModels } = require("../providers/models");
const { joinBaseUrl, safeFetch } = require("../providers/http");
const { readHttpErrorDetail } = require("../providers/request-util");
const { renderConfigPanelHtml } = require("./config-panel.html");

const DEFAULT_UPSTREAM_TIMEOUT_MS = 120000;

function summarizeRuntime({ cfgMgr, state }) {
  const cfg = cfgMgr?.get?.() || defaultConfig();
  const off = cfg?.official && typeof cfg.official === "object" ? cfg.official : {};
  const providers = Array.isArray(cfg?.providers) ? cfg.providers : [];

  const hasAuthHeader = (headers) => {
    const h = headers && typeof headers === "object" && !Array.isArray(headers) ? headers : {};
    const keys = Object.keys(h).map((k) => String(k || "").trim().toLowerCase());
    return keys.some((k) => k === "authorization" || k === "x-api-key" || k === "api-key" || k === "x-goog-api-key");
  };

  return {
    runtimeEnabled: Boolean(state?.runtimeEnabled),
    storageKey: typeof cfgMgr?.getStorageKey === "function" ? cfgMgr.getStorageKey() : "",
    official: {
      completionUrl: normalizeString(off.completionUrl),
      apiTokenSet: Boolean(normalizeString(off.apiToken))
    },
    providers: providers.map((p) => ({
      id: normalizeString(p?.id) || "(unknown)",
      type: normalizeString(p?.type),
      baseUrl: normalizeString(p?.baseUrl),
      defaultModel: normalizeString(p?.defaultModel),
      modelsCount: Array.isArray(p?.models) ? p.models.filter((m) => normalizeString(m)).length : 0,
      apiKeySet: Boolean(normalizeString(p?.apiKey)),
      headersCount: p?.headers && typeof p.headers === "object" && !Array.isArray(p.headers) ? Object.keys(p.headers).length : 0,
      authSet: Boolean(normalizeString(p?.apiKey)) || hasAuthHeader(p?.headers)
    }))
  };
}

function post(panel, msg) {
  try {
    panel.webview.postMessage(msg);
  } catch {}
}

function postStatus(panel, status) {
  post(panel, { type: "status", status: String(status || "") });
}

function postRender(panel, cfgMgr, state) {
  post(panel, { type: "render", config: cfgMgr.get(), summary: summarizeRuntime({ cfgMgr, state }) });
}

function createHandlers({ vscode, ctx, cfgMgr, state, panel }) {
  let selfTestController = null;
  let selfTestRunning = false;

  return {
    init: async () => {
      postRender(panel, cfgMgr, state);
    },
    reload: async () => {
      const rr = cfgMgr.reloadNow("panel_reload");
      postStatus(panel, rr.ok ? "Reloaded (OK)." : `Reload failed (${rr.reason || "unknown"}) (kept last-good).`);
      postRender(panel, cfgMgr, state);
    },
    reloadWindow: async () => {
      try {
        const pick = await vscode.window.showWarningMessage(
          "这会重载 VS Code（用于真正重载插件/主面板）。建议优先选择“重启扩展宿主”。",
          { modal: true },
          "重启扩展宿主",
          "重载窗口"
        );
        if (pick === "重启扩展宿主") {
          await vscode.commands.executeCommand("workbench.action.restartExtensionHost");
          return;
        }
        if (pick === "重载窗口") {
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
          return;
        }
        postStatus(panel, "Reload canceled.");
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        warn("reloadWindow failed:", m);
        postStatus(panel, `Reload failed: ${m}`);
      }
    },
    disableRuntime: async () => {
      await setRuntimeEnabledPersisted(ctx, false);
      info("BYOK disabled (rollback) via panel");
      postStatus(panel, "Runtime disabled (rollback to official).");
      postRender(panel, cfgMgr, state);
    },
    enableRuntime: async () => {
      await setRuntimeEnabledPersisted(ctx, true);
      info("BYOK enabled via panel");
      postStatus(panel, "Runtime enabled.");
      postRender(panel, cfgMgr, state);
    },
    reset: async () => {
      try {
        await cfgMgr.resetNow("panel_reset");
        postStatus(panel, "Reset to defaults (OK).");
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        warn("panel reset failed:", m);
        postStatus(panel, `Reset failed: ${m}`);
      }
      postRender(panel, cfgMgr, state);
    },
    save: async (msg) => {
      const raw = msg && typeof msg === "object" ? msg.config : null;
      try {
        await cfgMgr.saveNow(raw, "panel_save");
        postStatus(panel, "Saved (OK).");
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        warn("panel save failed:", m);
        postStatus(panel, `Save failed: ${m}`);
      }
      postRender(panel, cfgMgr, state);
    },
    clearHistorySummaryCache: async () => {
      try {
        const n = await clearHistorySummaryCacheAll();
        postStatus(panel, n ? `Cleared history summary cache (${n}).` : "History summary cache already empty.");
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        warn("panel clearHistorySummaryCache failed:", m);
        postStatus(panel, `Clear history summary cache failed: ${m}`);
      }
      postRender(panel, cfgMgr, state);
    },
    fetchProviderModels: async (msg) => {
      const idx = Number(msg?.idx);
      const provider = msg?.provider;
      try {
        const models = await fetchProviderModels({ provider, timeoutMs: 15000 });
        post(panel, { type: "providerModelsFetched", idx, models });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        warn("fetchProviderModels failed:", m);
        post(panel, { type: "providerModelsFailed", idx, error: `Fetch models failed: ${m}` });
      }
    },
    testOfficialGetModels: async (msg) => {
      const cfg = msg && typeof msg === "object" && msg.config && typeof msg.config === "object" ? msg.config : cfgMgr.get();
      const off = cfg?.official && typeof cfg.official === "object" ? cfg.official : {};
      const completionUrl = normalizeString(off.completionUrl) || "https://api.augmentcode.com/";
      const apiToken = normalizeRawToken(off.apiToken);

      const url = joinBaseUrl(completionUrl, "get-models");
      if (!url) {
        post(panel, { type: "officialGetModelsFailed", error: "Official /get-models failed: completion_url 无效（无法拼接 get-models）" });
        return;
      }

      const headers = { "content-type": "application/json" };
      if (apiToken) headers.authorization = `Bearer ${apiToken}`;

      try {
        const startedAtMs = Date.now();
        const resp = await safeFetch(url, { method: "POST", headers, body: "{}" }, { timeoutMs: 12000, label: "official/get-models" });
        if (!resp.ok) throw new Error(`get-models ${resp.status}: ${await readHttpErrorDetail(resp, { maxChars: 300 })}`.trim());
        const json = await resp.json().catch(() => null);
        if (!json || typeof json !== "object") throw new Error("get-models 响应不是 JSON 对象");

        const defaultModel = normalizeString(json.default_model ?? json.defaultModel);
        const modelsCount = Array.isArray(json.models) ? json.models.length : 0;
        const featureFlagsCount =
          json.feature_flags && typeof json.feature_flags === "object" && !Array.isArray(json.feature_flags) ? Object.keys(json.feature_flags).length : 0;

        post(panel, {
          type: "officialGetModelsOk",
          modelsCount,
          defaultModel,
          featureFlagsCount,
          elapsedMs: Date.now() - startedAtMs
        });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        warn("testOfficialGetModels failed:", m);
        post(panel, { type: "officialGetModelsFailed", error: `Official /get-models failed: ${m}` });
      }
    },
    cancelSelfTest: async () => {
      if (!selfTestRunning || !selfTestController) {
        postStatus(panel, "Self Test not running.");
        return;
      }
      try {
        selfTestController.abort(new Error("Self Test canceled by user"));
      } catch {}
      postStatus(panel, "Self Test canceled.");
    },
    runSelfTest: async (msg) => {
      if (selfTestRunning) {
        postStatus(panel, "Self Test already running.");
        return;
      }
      const cfg = msg && typeof msg === "object" && msg.config && typeof msg.config === "object" ? msg.config : cfgMgr.get();
      const timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS;

      selfTestRunning = true;
      selfTestController = new AbortController();
      post(panel, { type: "selfTestStarted", startedAtMs: Date.now() });
      postStatus(panel, "Self Test started...");

      try {
        await runSelfTest({
          cfg,
          timeoutMs: Math.min(60000, timeoutMs),
          abortSignal: selfTestController.signal,
          onEvent: (ev) => {
            const t = normalizeString(ev?.type);
            if (t === "log") post(panel, { type: "selfTestLog", line: String(ev?.line || "") });
            else if (t === "done") post(panel, { type: "selfTestDone", report: ev?.report || null });
          }
        });
        postStatus(panel, "Self Test finished.");
      } catch (err) {
        if (err && typeof err === "object" && err.name === "AbortError") {
          post(panel, { type: "selfTestCanceled" });
          postStatus(panel, "Self Test canceled.");
          return;
        }
        const m = err instanceof Error ? err.message : String(err);
        warn("selfTest failed:", m);
        post(panel, { type: "selfTestFailed", error: m });
        postStatus(panel, `Self Test failed: ${m}`);
      } finally {
        selfTestRunning = false;
        selfTestController = null;
      }
    }
  };
}

async function openConfigPanel({ vscode, ctx, cfgMgr, state }) {
  if (!vscode) throw new Error("vscode not available");
  if (!ctx) throw new Error("extension context not available");
  if (!cfgMgr || typeof cfgMgr.get !== "function") throw new Error("cfgMgr missing");

  const panel = vscode.window.createWebviewPanel("augment-byok.config", "BYOK Config", vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true
  });

  panel.webview.html = renderConfigPanelHtml({
    vscode,
    webview: panel.webview,
    ctx,
    init: { config: cfgMgr.get(), summary: summarizeRuntime({ cfgMgr, state }) }
  });

  const handlers = createHandlers({ vscode, ctx, cfgMgr, state, panel });
  panel.webview.onDidReceiveMessage(async (msg) => {
    const t = normalizeString(msg?.type);
    const fn = handlers[t];
    if (typeof fn === "function") await fn(msg);
  });

  postRender(panel, cfgMgr, state);
  return panel;
}

module.exports = { openConfigPanel };
