(function () {
  "use strict";

  const ns = (window.__byokCfgPanel = window.__byokCfgPanel || {});
  const { normalizeStr, uniq, escapeHtml, optionHtml } = ns;

  function computeOfficialTestUi(officialTest) {
    const ot = officialTest && typeof officialTest === "object" ? officialTest : {};
    const running = ot.running === true;
    const ok = ot.ok === true ? true : ot.ok === false ? false : null;
    const text = normalizeStr(ot.text);
    const textShort = text.length > 140 ? text.slice(0, 140) + "…" : text;
    const badgeHtml = running
      ? `<span class="status-badge status-badge--warning">testing</span>`
      : ok === true
        ? `<span class="status-badge status-badge--success">ok</span>`
        : ok === false
          ? `<span class="status-badge status-badge--error">failed</span>`
          : "";
    const textHtml = textShort
      ? `<span class="text-muted text-mono text-xs inline-ellipsis"${text !== textShort ? ` title="${escapeHtml(text)}"` : ""}>${escapeHtml(textShort)}</span>`
      : "";
    return { running, ok, text, textShort, badgeHtml, textHtml };
  }

  function summarizeSelfTestReportHtml(stReport) {
    if (!stReport) return "";
    const ps = Array.isArray(stReport.providers) ? stReport.providers : [];
    const total = ps.length;
    const failed = ps.filter((p) => p && p.ok === false).length;
    const globals = stReport.global && typeof stReport.global === "object" ? stReport.global : {};
    const gTests = Array.isArray(globals.tests) ? globals.tests : [];
    const gFailed = gTests.filter((x) => x && x.ok === false).length;
    const captured = globals.capturedTools && typeof globals.capturedTools === "object" ? globals.capturedTools : null;
    const capturedCount = Number.isFinite(Number(captured?.count)) ? Number(captured.count) : 0;
    const capturedSource = normalizeStr(captured?.source);
    const toolExec = globals.toolExec && typeof globals.toolExec === "object" ? globals.toolExec : null;
    const toolExecBadge =
      toolExec && toolExec.ok === true ? `<span class="badge">ok</span>` : toolExec && toolExec.ok === false ? `<span class="badge">failed</span>` : "";
    const failedTools = toolExec && Array.isArray(toolExec.failedTools) ? toolExec.failedTools : [];
    const failedToolsText = failedTools.length ? `${failedTools.join(",")}${toolExec && toolExec.failedToolsTruncated ? ",…" : ""}` : "";
    const badge = stReport.ok === true ? `<span class="badge">ok</span>` : `<span class="badge">failed</span>`;
    return (
      `<div class="small">result: ${badge} providers_failed=${failed}/${total} global_failed=${gFailed}/${gTests.length}</div>` +
      `<div class="small">captured_tools: <span class="badge">${capturedCount}</span>${capturedSource ? ` <span class="text-muted text-xs">(${escapeHtml(capturedSource)})</span>` : ""}</div>` +
      (toolExec ? `<div class="small">toolsExec: ${toolExecBadge} ${escapeHtml(String(toolExec.detail || ""))}</div>` : "") +
      (failedToolsText ? `<div class="small mono">failed_tools: ${escapeHtml(failedToolsText)}</div>` : "")
    );
  }

  ns.renderApp = function renderApp({
    cfg,
    runtimeEnabled,
    status,
    modal,
    dirty,
    endpointSearch,
    selfTest,
    selfTestProviderKeys,
    officialTest,
    providerExpanded
  }) {
    const c = cfg && typeof cfg === "object" ? cfg : {};
    const off = c.official && typeof c.official === "object" ? c.official : {};
    const endpointSearchText = normalizeStr(endpointSearch);

    const st = selfTest && typeof selfTest === "object" ? selfTest : {};
    const stRunning = st.running === true;
    const stLogs = Array.isArray(st.logs) ? st.logs : [];
    const stReport = st.report && typeof st.report === "object" ? st.report : null;

    const providers = Array.isArray(c.providers) ? c.providers : [];
    const providerKeyByIndex = (p, idx) => normalizeStr(p?.id) || `idx:${idx}`;
    const stProviderKeysRaw = Array.isArray(selfTestProviderKeys) ? selfTestProviderKeys : [];
    const stProviderKeysConfigured = uniq(stProviderKeysRaw.map((k) => normalizeStr(k)).filter(Boolean));
    const availableProviderKeys = providers.map((p, idx) => providerKeyByIndex(p, idx)).filter(Boolean);
    const availableProviderKeySet = new Set(availableProviderKeys);
    const stProviderKeys = stProviderKeysConfigured.filter((k) => availableProviderKeySet.has(k));
    const stProviderKeySet = new Set(stProviderKeys);
    const selfTestProvidersHtml = providers.length
      ? providers
          .map((p, idx) => {
            const pid = normalizeStr(p?.id);
            const type = normalizeStr(p?.type);
            const pKey = providerKeyByIndex(p, idx);
            const title = pid || `provider_${idx + 1}`;
            const checked = stProviderKeySet.has(pKey);
            const disabled = stRunning ? "disabled" : "";
            return `
              <label class="selftest-provider-item${checked ? " is-checked" : ""}" title="${escapeHtml(type || pKey)}">
                <input class="selftest-provider-checkbox" type="checkbox" data-selftest-provider-key="${escapeHtml(pKey)}" ${checked ? "checked" : ""} ${disabled} />
                <span class="selftest-provider-checkbox-ui" aria-hidden="true"></span>
                <span class="selftest-provider-label">
                  <span class="text-mono">${escapeHtml(title)}</span>
                  ${type ? `<span class="text-muted text-xs">(${escapeHtml(type)})</span>` : ""}
                </span>
              </label>
            `;
          })
          .join("")
      : `<div class="text-muted text-xs">(no providers configured)</div>`;

    const isDirty = dirty === true;
    const runtimeEnabledFlag = runtimeEnabled === true;

    const otUi = computeOfficialTestUi(officialTest);
    const otRunning = otUi.running;
    const otBadge = otUi.badgeHtml;
    const otTextHtml = otUi.textHtml;

    const summarizeSelfTestReport = () => summarizeSelfTestReportHtml(stReport);

    const selfTestHtml = `
	      <section class="settings-panel">
	        <header class="settings-panel__header">
	          <div class="flex-row flex-wrap">
	            <span>Self Test</span>
	            ${stRunning ? `<span class="status-badge status-badge--warning">running</span>` : stReport ? (stReport.ok === true ? `<span class="status-badge status-badge--success">ok</span>` : `<span class="status-badge status-badge--error">failed</span>`) : ""}
	          </div>
	          <div class="flex-row flex-wrap">
	            <button class="btn btn--small btn--primary" data-action="runSelfTest" ${stRunning ? "disabled" : ""}>Run</button>
	            <button class="btn btn--small" data-action="cancelSelfTest" ${stRunning ? "" : "disabled"}>Cancel</button>
	            <button class="btn btn--small" data-action="clearSelfTest" ${stRunning ? "disabled" : ""}>Clear</button>
	          </div>
	        </header>
	        <div class="settings-panel__body">
	          <div class="text-muted text-xs">覆盖：models / 非流式 / 流式 / chat-stream / 真实工具集(schema+tool_use 往返) / 真实工具执行(toolsModel.callTool 全覆盖) / 多模态 / 上下文压缩(historySummary) / 缓存命中。</div>
	          <div class="selftest-grid">
	            <div class="selftest-controls">
	              <div class="form-group">
	                <label class="form-label">Providers（可多选）</label>
	                <div class="selftest-provider-list" role="group" aria-label="Self Test Providers">${selfTestProvidersHtml}</div>
	                <div class="text-muted text-xs">提示：不选=全部。</div>
	              </div>
	              <div class="flex-row flex-wrap row tight">
	                <button class="btn btn--small" data-action="selfTestSelectAllProviders" ${stRunning || !providers.length ? "disabled" : ""}>全选</button>
	                <button class="btn btn--small" data-action="selfTestClearSelectedProviders" ${stRunning ? "disabled" : ""}>清空</button>
	                <span class="text-muted text-xs">${escapeHtml(stProviderKeys.length ? `selected=${stProviderKeys.length}` : `selected=all (${providers.length})`)}</span>
	              </div>
	              ${summarizeSelfTestReport()}
	            </div>
	            <div class="selftest-log">
	              <label class="form-label">Logs</label>
	              <textarea class="mono" id="selfTestLog" readonly>${escapeHtml(stLogs.join("\n"))}</textarea>
	            </div>
	          </div>
	        </div>
	      </section>
	    `;

    const headerBadges = [
      `<span class="status-badge">schema v1</span>`,
      runtimeEnabledFlag ? `<span class="status-badge status-badge--success">BYOK: ON</span>` : `<span class="status-badge status-badge--warning">BYOK: OFF</span>`,
      `<span class="status-badge${isDirty ? " status-badge--warning" : " status-badge--success"}" id="dirtyBadge">${isDirty ? "pending" : "saved"}</span>`
    ].join("");

    const appHeader = `
	      <header class="app-header">
	        <div class="app-title">
	          <h1>
	            Augment BYOK
	            ${headerBadges}
	          </h1>
	          <div class="text-muted text-xs" id="status">${escapeHtml(status || "Ready.")}</div>
	          <div class="text-muted text-xs">提示：保存后生效；刷新会丢弃未保存修改。</div>
	        </div>
	        <div class="header-actions flex-row flex-wrap">
	          <label class="checkbox-wrapper" title="开启或关闭 BYOK 运行时（关闭=回滚到官方）">
	            <input type="checkbox" id="runtimeEnabledToggle" ${runtimeEnabledFlag ? "checked" : ""} />
	            <span>启用 BYOK</span>
	          </label>
	          <button class="btn btn--small" data-action="importConfig" title="从 JSON 文件导入配置（会覆盖当前配置）">导入</button>
	          <button class="btn btn--small" data-action="exportConfig" title="导出当前配置到 JSON 文件（可选择是否包含密钥）">导出</button>
	          <button class="btn btn--small" data-action="reload" title="重新加载配置（丢弃未保存修改）">刷新</button>
	          <button class="btn btn--small btn--primary" data-action="save" title="保存配置到 extension storage">保存</button>
	          <button class="btn btn--small" data-action="reset" title="重置为默认配置（会清空已存储的 token/key）">重置</button>
	          <button class="btn btn--small" data-action="reloadWindow" title="重载 VS Code 窗口（会重载插件与主面板）">重载</button>
	        </div>
	      </header>
	    `;

    const completionUrl = normalizeStr(off.completionUrl ?? "");
    const completionUrlValid = !completionUrl || /^https?:\/\//i.test(completionUrl);
    const completionUrlBadge = completionUrlValid
      ? `<span class="status-badge status-badge--success">url: ok</span>`
      : `<span class="status-badge status-badge--error">url: invalid</span>`;
    const tokenSet = Boolean(normalizeStr(off.apiToken));
    const tokenBadge = tokenSet
      ? `<span class="status-badge status-badge--success">token: set</span>`
      : `<span class="status-badge status-badge--warning">token: empty (optional)</span>`;

    const official = `
	      <section class="settings-panel">
	        <header class="settings-panel__header">
	          <div class="flex-row flex-wrap">
	            <span>Official</span>
	            ${completionUrlBadge}
	            ${tokenBadge}
	          </div>
	          <div class="flex-row" style="min-width:0;">
	            <button class="btn btn--small" data-action="testOfficialGetModels" ${otRunning ? "disabled" : ""} title="/get-models">测试连接</button>
	            ${otBadge}
	            ${otTextHtml}
	          </div>
	        </header>
	        <div class="settings-panel__body">
	          <div class="form-grid">
	            <div class="form-group">
	              <label class="form-label" for="officialCompletionUrl">Completion URL</label>
	              <input type="url" id="officialCompletionUrl" value="${escapeHtml(off.completionUrl ?? "")}" placeholder="https://&lt;tenant&gt;.augmentcode.com/" />
	              <div class="text-muted text-xs">默认官方；私有租户填你的域名。用于官方上下文注入 + <span class="text-mono">/get-models</span> 合并。</div>
	            </div>
	            <div class="form-group">
	              <div class="flex-between flex-row">
	                <label class="form-label" for="officialApiToken">API Token</label>
	                ${tokenBadge}
	              </div>
	              <div class="flex-row">
	                <input type="password" id="officialApiToken" value="" placeholder="${off.apiToken ? "(set)" : "(empty)"}" />
	                <button class="btn btn--icon btn--danger" data-action="clearOfficialToken" title="清空 Token">✕</button>
	              </div>
	              <div class="text-muted text-xs">可选：私有租户/需要官方注入才需配置。留空=不改；点击 ✕=清空（保存后生效）。</div>
	            </div>
	          </div>
	        </div>
	      </section>
	    `;

    const providersHtml =
      typeof ns.renderProvidersPanel === "function"
        ? ns.renderProvidersPanel({ providers, providerExpanded })
        : `<div class="text-muted text-xs">providers renderer missing</div>`;

    const historySummary = c.historySummary && typeof c.historySummary === "object" ? c.historySummary : {};
    const hsEnabled = historySummary.enabled === true;
    const hsProviderId = normalizeStr(historySummary.providerId);
    const hsModel = normalizeStr(historySummary.model);
    const hsByokModel = hsProviderId && hsModel ? `byok:${hsProviderId}:${hsModel}` : "";
    const hsPrompt = normalizeStr(historySummary.prompt);
    const hsTriggerStrategyRaw = normalizeStr(historySummary.triggerStrategy).toLowerCase();
    const hsTriggerStrategy = hsTriggerStrategyRaw === "ratio" || hsTriggerStrategyRaw === "chars" ? hsTriggerStrategyRaw : "auto";
    const numberOrEmpty = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? String(n) : "";
    };
    const hsTriggerOnContextRatio = numberOrEmpty(historySummary.triggerOnContextRatio);
    const hsTargetContextRatio = numberOrEmpty(historySummary.targetContextRatio);
    const hsTriggerOnHistorySizeChars = numberOrEmpty(historySummary.triggerOnHistorySizeChars);
    const hsContextWindowTokensDefault = numberOrEmpty(historySummary.contextWindowTokensDefault);
    const hsHistoryTailSizeCharsToExclude = numberOrEmpty(historySummary.historyTailSizeCharsToExclude);
    const hsMinTailExchanges = numberOrEmpty(historySummary.minTailExchanges);
    const hsMaxTokens = numberOrEmpty(historySummary.maxTokens);
    const hsTimeoutSeconds = numberOrEmpty(historySummary.timeoutSeconds);
    const hsCacheTtlMs = numberOrEmpty(historySummary.cacheTtlMs);
    const hsMaxSummarizationInputChars = numberOrEmpty(historySummary.maxSummarizationInputChars);
    const hsRollingSummary = historySummary.rollingSummary === true;
    let hsContextWindowTokensOverrides = "";
    try {
      const overrides = historySummary.contextWindowTokensOverrides;
      if (overrides && typeof overrides === "object" && !Array.isArray(overrides) && Object.keys(overrides).length) {
        hsContextWindowTokensOverrides = JSON.stringify(overrides, null, 2);
      }
    } catch {}
    const hsModelGroups = providers
      .map((p) => {
        const pid = normalizeStr(p?.id);
        const dm = normalizeStr(p?.defaultModel);
        const rawModels = Array.isArray(p?.models) ? p.models : [];
        const models = uniq(rawModels.map((m) => normalizeStr(m)).filter(Boolean).concat(dm ? [dm] : [])).sort((a, b) => a.localeCompare(b));
        return { pid, models };
      })
      .filter((g) => g && g.pid && Array.isArray(g.models) && g.models.length)
      .sort((a, b) => a.pid.localeCompare(b.pid));
    const historySummaryHtml = `
	      <section class="settings-panel">
	        <header class="settings-panel__header">
	          <span>History Summary</span>
	          ${hsEnabled ? `<span class="status-badge status-badge--success">enabled</span>` : `<span class="status-badge status-badge--warning">disabled</span>`}
	        </header>
	        <div class="settings-panel__body">
	          <div class="form-grid">
	            <div class="form-group">
	              <label class="form-label">启用</label>
	              <label class="checkbox-wrapper">
	                <input type="checkbox" id="historySummaryEnabled" ${hsEnabled ? "checked" : ""} />
	                <span>启用</span>
	              </label>
	              <div class="text-muted text-xs">启用后会在后台自动做“滚动摘要”，用于避免上下文溢出（仅影响发给上游模型的内容）。</div>
	            </div>
	            <div class="form-group">
	              <label class="form-label">Model</label>
	              <select id="historySummaryByokModel">
	                ${optionHtml({ value: "", label: "(follow current request)", selected: !hsByokModel })}
	                ${hsModelGroups
                  .map((g) => {
                    const options = g.models
                      .map((m) => {
                        const v = `byok:${g.pid}:${m}`;
                        return optionHtml({ value: v, label: m, selected: v === hsByokModel });
                      })
                      .join("");
                    return `<optgroup label="${escapeHtml(g.pid)}">${options}</optgroup>`;
                  })
                  .join("")}
	              </select>
	              <div class="text-muted text-xs">留空则跟随当前请求模型（仅用于“生成摘要”）；触发窗口判断始终基于当前对话模型。</div>
	            </div>
	            <div class="form-group form-grid--full">
	              <div class="flex-row flex-wrap">
	                <button class="btn btn--small" data-action="clearHistorySummaryCache">清理摘要缓存</button>
	                <span class="text-muted text-xs">仅清理后台摘要复用缓存，不影响 UI 历史显示。</span>
	              </div>
	            </div>
              <div class="form-group form-grid--full">
                <details class="endpoint-group">
                  <summary class="endpoint-group-summary">
                    <span>Advanced</span>
                    <span class="row" style="gap:6px;">
                      <span class="badge">trigger</span>
                      <span class="badge">tail</span>
                      <span class="badge">cache</span>
                      <span class="badge">window</span>
                      <span class="badge">prompt</span>
                    </span>
                  </summary>
                  <div class="endpoint-group-body">
	                    <div class="text-muted text-xs">高级参数可选；留空会回落默认值。内置已覆盖常见编程模型（Claude4/GPT5/Gemini/Kimi）。</div>
                    <div style="height:10px;"></div>
                    <div class="form-grid">
                      <div class="form-group">
                        <label class="form-label" for="historySummaryTriggerStrategy">Trigger Strategy</label>
                        <select id="historySummaryTriggerStrategy">
                          ${optionHtml({ value: "auto", label: "auto (recommended)", selected: hsTriggerStrategy === "auto" })}
                          ${optionHtml({ value: "ratio", label: "ratio", selected: hsTriggerStrategy === "ratio" })}
                          ${optionHtml({ value: "chars", label: "chars", selected: hsTriggerStrategy === "chars" })}
                        </select>
                      </div>
                      <div class="form-group">
                        <label class="form-label" for="historySummaryTriggerOnHistorySizeChars">Trigger Chars (fallback)</label>
                        <input id="historySummaryTriggerOnHistorySizeChars" type="number" min="1" step="1" value="${escapeHtml(hsTriggerOnHistorySizeChars)}" placeholder="800000" />
                      </div>
                      <div class="form-group">
                        <label class="form-label" for="historySummaryTriggerOnContextRatio">Trigger Ratio</label>
                        <input id="historySummaryTriggerOnContextRatio" type="number" min="0.1" max="0.95" step="0.01" value="${escapeHtml(hsTriggerOnContextRatio)}" placeholder="0.70" />
                      </div>
                      <div class="form-group">
                        <label class="form-label" for="historySummaryTargetContextRatio">Target Ratio</label>
                        <input id="historySummaryTargetContextRatio" type="number" min="0.1" max="0.95" step="0.01" value="${escapeHtml(hsTargetContextRatio)}" placeholder="0.55" />
                      </div>
                      <div class="form-group">
                        <label class="form-label" for="historySummaryHistoryTailSizeCharsToExclude">Tail Chars Exclude</label>
                        <input id="historySummaryHistoryTailSizeCharsToExclude" type="number" min="0" step="1" value="${escapeHtml(hsHistoryTailSizeCharsToExclude)}" placeholder="250000" />
                      </div>
                      <div class="form-group">
                        <label class="form-label" for="historySummaryMinTailExchanges">Min Tail Exchanges</label>
                        <input id="historySummaryMinTailExchanges" type="number" min="1" step="1" value="${escapeHtml(hsMinTailExchanges)}" placeholder="2" />
                      </div>
                      <div class="form-group">
                        <label class="form-label" for="historySummaryMaxTokens">Summary Max Tokens</label>
                        <input id="historySummaryMaxTokens" type="number" min="1" step="1" value="${escapeHtml(hsMaxTokens)}" placeholder="1024" />
                      </div>
                      <div class="form-group">
                        <label class="form-label" for="historySummaryTimeoutSeconds">Summary Timeout (s)</label>
                        <input id="historySummaryTimeoutSeconds" type="number" min="1" step="1" value="${escapeHtml(hsTimeoutSeconds)}" placeholder="60" />
                      </div>
                      <div class="form-group">
                        <label class="form-label" for="historySummaryCacheTtlMs">Cache TTL (ms)</label>
                        <input id="historySummaryCacheTtlMs" type="number" min="0" step="1" value="${escapeHtml(hsCacheTtlMs)}" placeholder="0" />
                      </div>
                      <div class="form-group">
                        <label class="form-label" for="historySummaryMaxSummarizationInputChars">Summarization Input Chars</label>
                        <input id="historySummaryMaxSummarizationInputChars" type="number" min="0" step="1" value="${escapeHtml(hsMaxSummarizationInputChars)}" placeholder="250000" />
                      </div>
                      <div class="form-group">
                        <label class="form-label" for="historySummaryContextWindowTokensDefault">Context Window Default (tokens)</label>
                        <input id="historySummaryContextWindowTokensDefault" type="number" min="0" step="1" value="${escapeHtml(hsContextWindowTokensDefault)}" placeholder="0" />
                      </div>
                      <div class="form-group">
                        <label class="form-label">Rolling Summary</label>
                        <label class="checkbox-wrapper">
                          <input type="checkbox" id="historySummaryRollingSummary" ${hsRollingSummary ? "checked" : ""} />
                          <span>启用缓存增量摘要</span>
                        </label>
                      </div>
                      <div class="form-group form-grid--full">
                        <label class="form-label" for="historySummaryContextWindowTokensOverrides">Context Window Overrides (JSON object)</label>
                        <textarea class="mono" id="historySummaryContextWindowTokensOverrides" rows="6" placeholder='{"gpt-5.3-codex":400000,"gpt-5.2":400000,"claude-4.6-opus":1000000,"gemini-3-pro":1000000,"kimi-k2":128000}'>${escapeHtml(hsContextWindowTokensOverrides)}</textarea>
                        <div class="text-muted text-xs">按“当前对话模型名”子串匹配，长度优先；大小写不敏感。此项不改变摘要模型。</div>
                      </div>
                      <div class="form-group form-grid--full">
                        <label class="form-label" for="historySummaryPrompt">Prompt</label>
                        <textarea class="mono" id="historySummaryPrompt" rows="6" placeholder="(default)">${escapeHtml(hsPrompt)}</textarea>
                        <div class="text-muted text-xs">建议保持简洁、结构化；避免泄漏敏感信息。留空会回落默认模板。</div>
                      </div>
                    </div>
                  </div>
                </details>
              </div>
	          </div>
	        </div>
	      </section>
	    `;

    const promptsHtml =
      typeof ns.renderPromptsPanel === "function"
        ? ns.renderPromptsPanel({ cfg: c })
        : `<div class="text-muted text-xs">prompts renderer missing</div>`;

    const endpointRules =
      typeof ns.renderEndpointRulesPanel === "function"
        ? ns.renderEndpointRulesPanel({ cfg: c, endpointSearchText })
        : `<div class="text-muted text-xs">endpoint rules renderer missing</div>`;

    const m = modal && typeof modal === "object" ? modal : null;
    const mKind = normalizeStr(m?.kind);
    const mIdx = Number(m?.idx);
    const mProvider = Number.isFinite(mIdx) && mIdx >= 0 && mIdx < providers.length ? providers[mIdx] : null;
    const modalHtml =
      !mKind
        ? ""
        : mKind === "confirmReset"
          ? `
              <div class="modal-backdrop">
                <div class="modal card">
                  <div class="title">Reset to defaults?</div>
                  <div class="hint">这会覆盖存储在 extension globalState 里的 BYOK 配置（token/key 也会被清空）。</div>
                  <div class="row" style="margin-top:10px;justify-content:flex-end;">
                    <button class="btn" data-action="modalCancel">Cancel</button>
                    <button class="btn danger" data-action="confirmReset">Reset</button>
                  </div>
                </div>
              </div>
            `
          : !mProvider
            ? ""
            : (() => {
                const title =
                  mKind === "models"
                    ? `Edit models (Provider #${mIdx + 1})`
                    : mKind === "headers"
                      ? `Edit headers (Provider #${mIdx + 1})`
                      : `Edit request_defaults (Provider #${mIdx + 1})`;
                const text =
                  mKind === "models"
                    ? (Array.isArray(mProvider.models) ? mProvider.models : []).join("\n")
                    : JSON.stringify(mKind === "headers" ? (mProvider.headers ?? {}) : (mProvider.requestDefaults ?? {}), null, 2);
                const hint = mKind === "models" ? "每行一个 model id（用于下拉选择与 /get-models 注入）。" : "请输入 JSON 对象（会在 Save 时持久化）。";

                return `
              <div class="modal-backdrop">
                <div class="modal card">
                  <div class="title">${escapeHtml(title)}</div>
                  <div class="hint">${escapeHtml(hint)}</div>
                  <textarea class="mono" id="modalText" style="min-height:240px;">${escapeHtml(text)}</textarea>
                  <div class="row" style="margin-top:10px;justify-content:flex-end;">
                    <button class="btn" data-action="modalCancel">Cancel</button>
                    <button class="btn primary" data-action="modalApply">Apply</button>
                  </div>
                </div>
              </div>
	            `;
              })();

    return `
	      <div class="app-container">
	        ${appHeader}
	        ${official}
	        ${providersHtml}
	        ${historySummaryHtml}
	        ${promptsHtml}
	        ${endpointRules}
	        ${selfTestHtml}
	      </div>
	      ${modalHtml}
	    `;
  };
})();
