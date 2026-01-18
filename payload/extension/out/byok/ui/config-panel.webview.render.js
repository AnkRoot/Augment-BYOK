(function () {
  "use strict";

  const ns = (window.__byokCfgPanel = window.__byokCfgPanel || {});
  const { normalizeStr, uniq, escapeHtml, optionHtml, computeProviderIndexById } = ns;

  const ENDPOINT_GROUPS_V1 = [
    {
      id: "llm_data_plane",
      label: "LLM 数据面（13）",
      endpoints: [
        "/get-models",
        "/chat",
        "/completion",
        "/chat-input-completion",
        "/edit",
        "/next_edit_loc",
        "/chat-stream",
        "/prompt-enhancer",
        "/instruction-stream",
        "/smart-paste-stream",
        "/next-edit-stream",
        "/generate-commit-message-stream",
        "/generate-conversation-title"
      ]
    },
    {
      id: "remote_agents",
      label: "Remote Agents（15）",
      endpoints: [
        "/remote-agents/create",
        "/remote-agents/update",
        "/remote-agents/delete",
        "/remote-agents/list",
        "/remote-agents/list-stream",
        "/remote-agents/chat",
        "/remote-agents/get-chat-history",
        "/remote-agents/agent-history-stream",
        "/remote-agents/logs",
        "/remote-agents/interrupt",
        "/remote-agents/pause",
        "/remote-agents/resume",
        "/remote-agents/resume-hint",
        "/remote-agents/generate-summary",
        "/remote-agents/add-ssh-key"
      ]
    },
    {
      id: "agents_tools",
      label: "Agents / Tools（6）",
      endpoints: [
        "/agents/check-tool-safety",
        "/agents/revoke-tool-access",
        "/agents/list-remote-tools",
        "/agents/run-remote-tool",
        "/agents/edit-file",
        "/agents/codebase-retrieval"
      ]
    },
    {
      id: "blobs_context_sync",
      label: "文件/Blob/上下文同步（7）",
      endpoints: [
        "/batch-upload",
        "/checkpoint-blobs",
        "/find-missing",
        "/save-chat",
        "/context-canvas/list",
        "/get-implicit-external-sources",
        "/search-external-sources"
      ]
    },
    {
      id: "github",
      label: "GitHub 集成（4）",
      endpoints: [
        "/github/is-user-configured",
        "/github/list-repos",
        "/github/list-branches",
        "/github/get-repo"
      ]
    },
    {
      id: "auth_subscription_secrets",
      label: "账号/订阅/权限/Secrets（7）",
      endpoints: [
        "/token",
        "/get-credit-info",
        "/subscription-banner",
        "/settings/get-tenant-tool-permissions",
        "/user-secrets/list",
        "/user-secrets/upsert",
        "/user-secrets/delete"
      ]
    },
    {
      id: "feedback_telemetry_debug",
      label: "反馈/遥测/调试（17）",
      endpoints: [
        "/chat-feedback",
        "/completion-feedback",
        "/next-edit-feedback",
        "/client-metrics",
        "/client-completion-timelines",
        "/record-session-events",
        "/record-user-events",
        "/record-preference-sample",
        "/record-request-events",
        "/report-error",
        "/report-feature-vector",
        "/resolve-completions",
        "/resolve-chat-input-completion",
        "/resolve-edit",
        "/resolve-instruction",
        "/resolve-next-edit",
        "/resolve-smart-paste"
      ]
    },
    {
      id: "notifications",
      label: "通知（2）",
      endpoints: [
        "/notifications/read",
        "/notifications/mark-as-read"
      ]
    }
  ];

  const ENDPOINT_MEANINGS_V1 = {
    "/get-models": "拉取可用模型/feature flags（并可注入 BYOK models registry）",
    "/chat": "非流式 chat（或某些场景的 chat 请求）",
    "/completion": "编辑器 inline completion（短文本）",
    "/chat-input-completion": "Chat 输入框智能补全",
    "/edit": "代码编辑/改写（输出文本或结构化编辑结果）",
    "/next_edit_loc": "Next Edit 定位（候选位置 JSON）",
    "/chat-stream": "核心聊天流（Augment NDJSON）",
    "/prompt-enhancer": "提示词增强（stream）",
    "/instruction-stream": "指令生成/改写（stream）",
    "/smart-paste-stream": "Smart Paste（stream）",
    "/next-edit-stream": "Next Edit 建议（stream）",
    "/generate-commit-message-stream": "Commit message（stream）",
    "/generate-conversation-title": "会话标题（stream）",

    "/remote-agents/create": "创建远程 agent",
    "/remote-agents/update": "更新配置",
    "/remote-agents/delete": "删除",
    "/remote-agents/list": "列表（一次性）",
    "/remote-agents/list-stream": "列表（流式更新）",
    "/remote-agents/chat": "与远程 agent 对话/下达任务",
    "/remote-agents/get-chat-history": "拉取对话历史（一次性）",
    "/remote-agents/agent-history-stream": "对话/事件历史流",
    "/remote-agents/logs": "日志",
    "/remote-agents/interrupt": "中断执行",
    "/remote-agents/pause": "暂停",
    "/remote-agents/resume": "恢复",
    "/remote-agents/resume-hint": "恢复提示/状态同步",
    "/remote-agents/generate-summary": "生成摘要",
    "/remote-agents/add-ssh-key": "写入 SSH key",

    "/agents/check-tool-safety": "工具安全性检查/准入",
    "/agents/revoke-tool-access": "撤销工具权限",
    "/agents/list-remote-tools": "列出可用远程工具",
    "/agents/run-remote-tool": "执行远程工具",
    "/agents/edit-file": "通过 agent 执行文件编辑",
    "/agents/codebase-retrieval": "代码库检索",

    "/batch-upload": "批量上传 blobs（文件内容/上下文）",
    "/checkpoint-blobs": "checkpoint 相关 blobs 操作",
    "/find-missing": "查找缺失 blob",
    "/save-chat": "保存会话/记录（服务端持久化）",
    "/context-canvas/list": "Context Canvas 列表",
    "/get-implicit-external-sources": "隐式外部来源",
    "/search-external-sources": "外部来源搜索",

    "/github/is-user-configured": "是否已配置 GitHub",
    "/github/list-repos": "仓库列表",
    "/github/list-branches": "分支列表",
    "/github/get-repo": "获取指定 repo 信息/元数据",

    "/token": "token 获取/刷新（鉴权相关）",
    "/get-credit-info": "额度/credits 信息",
    "/subscription-banner": "订阅提示 banner",
    "/settings/get-tenant-tool-permissions": "tenant 级工具权限配置",
    "/user-secrets/list": "列出用户 secrets",
    "/user-secrets/upsert": "写入/更新 secrets",
    "/user-secrets/delete": "删除 secrets",

    "/chat-feedback": "聊天反馈",
    "/completion-feedback": "补全反馈",
    "/next-edit-feedback": "Next Edit 反馈",
    "/client-metrics": "客户端指标",
    "/client-completion-timelines": "completion timeline（行为序列）",
    "/record-session-events": "会话事件",
    "/record-user-events": "用户事件",
    "/record-preference-sample": "偏好样本（用于训练/评估）",
    "/record-request-events": "请求事件记录",
    "/report-error": "错误上报",
    "/report-feature-vector": "特征向量上报",
    "/resolve-completions": "resolve*（日志/归因类）",
    "/resolve-chat-input-completion": "resolve*（日志/归因类）",
    "/resolve-edit": "resolve*（日志/归因类）",
    "/resolve-instruction": "resolve*（日志/归因类）",
    "/resolve-next-edit": "resolve*（日志/归因类）",
    "/resolve-smart-paste": "resolve*（日志/归因类）",

    "/notifications/read": "拉取通知",
    "/notifications/mark-as-read": "标记已读"
  };

  ns.summarizeSummaryBox = function summarizeSummaryBox(summary) {
    const s = summary && typeof summary === "object" ? summary : {};
    const off = s.official && typeof s.official === "object" ? s.official : {};
    const providers = Array.isArray(s.providers) ? s.providers : [];

    const lines = [];
    lines.push(`<div class="title">Runtime</div>`);
    lines.push(`<div class="small">runtimeEnabled: <span class="mono">${escapeHtml(String(Boolean(s.runtimeEnabled)))}</span></div>`);
    if (s.storageKey) lines.push(`<div class="small">storageKey: <span class="mono">${escapeHtml(String(s.storageKey))}</span></div>`);

    lines.push(`<div style="height:10px"></div>`);
    lines.push(`<div class="title">Official</div>`);
    lines.push(`<div class="small">completionUrl: <span class="mono">${escapeHtml(off.completionUrl || "")}</span></div>`);
    lines.push(`<div class="small">apiToken: ${off.apiTokenSet ? `<span class="badge">set</span>` : `<span class="badge">empty</span>`}</div>`);

    lines.push(`<div style="height:10px"></div>`);
    lines.push(`<div class="title">Providers</div>`);
    if (!providers.length) lines.push(`<div class="small">(none)</div>`);
    for (const p of providers) {
      lines.push(`<div class="card" style="padding:8px;margin-top:8px;">`);
      lines.push(`<div class="small"><span class="mono">${escapeHtml(p.id)}</span> <span class="badge">${escapeHtml(p.type || "")}</span></div>`);
      if (p.baseUrl) lines.push(`<div class="small">baseUrl: <span class="mono">${escapeHtml(p.baseUrl)}</span></div>`);
      if (p.defaultModel) lines.push(`<div class="small">defaultModel: <span class="mono">${escapeHtml(p.defaultModel)}</span></div>`);
      lines.push(`<div class="small">auth: ${p.authSet ? `<span class="badge">set</span>` : `<span class="badge">empty</span>`}</div>`);
      lines.push(`<div class="small">apiKey: ${p.apiKeySet ? `<span class="badge">set</span>` : `<span class="badge">empty</span>`}</div>`);
      lines.push(`<div class="small">headers: <span class="mono">${escapeHtml(String(p.headersCount || 0))}</span></div>`);
      lines.push(`<div class="small">models: <span class="mono">${escapeHtml(String(p.modelsCount || 0))}</span></div>`);
      lines.push(`</div>`);
    }

    return lines.join("");
  };

  ns.renderApp = function renderApp({ cfg, summary, status, modal, dirty, sideCollapsed, endpointSearch, selfTest, officialTest, providerExpanded }) {
    const c = cfg && typeof cfg === "object" ? cfg : {};
    const s = summary && typeof summary === "object" ? summary : {};
    const off = c.official && typeof c.official === "object" ? c.official : {};
    const routing = c.routing && typeof c.routing === "object" ? c.routing : {};
    const endpointSearchText = normalizeStr(endpointSearch);

    const providers = Array.isArray(c.providers) ? c.providers : [];
    const providerIds = providers.map((p) => normalizeStr(p?.id)).filter(Boolean);

    const rulesObj = routing.rules && typeof routing.rules === "object" ? routing.rules : {};
    const ruleEndpoints = Object.keys(rulesObj).sort();
    const knownEndpoints = uniq(ENDPOINT_GROUPS_V1.flatMap((g) => (Array.isArray(g?.endpoints) ? g.endpoints : [])));
    const knownEndpointSet = new Set(knownEndpoints);
    const unknownRuleEndpoints = uniq(ruleEndpoints.filter((ep) => ep && !knownEndpointSet.has(ep)));

    const isDirty = dirty === true;
    const isSideCollapsed = sideCollapsed === true;
    const runtimeEnabled = s.runtimeEnabled === true;

    const st = selfTest && typeof selfTest === "object" ? selfTest : {};
    const stRunning = st.running === true;
    const stLogs = Array.isArray(st.logs) ? st.logs : [];
    const stReport = st.report && typeof st.report === "object" ? st.report : null;

	    const ot = officialTest && typeof officialTest === "object" ? officialTest : {};
	    const otRunning = ot.running === true;
	    const otOk = ot.ok === true ? true : ot.ok === false ? false : null;
	    const otText = normalizeStr(ot.text);
	    const otTextShort = otText.length > 140 ? otText.slice(0, 140) + "…" : otText;
	    const otBadge = otRunning
	      ? `<span class="status-badge status-badge--warning">testing</span>`
	      : otOk === true
	        ? `<span class="status-badge status-badge--success">ok</span>`
	        : otOk === false
	          ? `<span class="status-badge status-badge--error">failed</span>`
	          : "";
	    const otTextHtml = otTextShort
	      ? `<span class="text-muted text-mono text-xs inline-ellipsis"${otText !== otTextShort ? ` title="${escapeHtml(otText)}"` : ""}>${escapeHtml(otTextShort)}</span>`
	      : "";

    const summarizeSelfTestReport = () => {
      if (!stReport) return "";
      const ps = Array.isArray(stReport.providers) ? stReport.providers : [];
      const total = ps.length;
      const failed = ps.filter((p) => p && p.ok === false).length;
      const globals = stReport.global && typeof stReport.global === "object" ? stReport.global : {};
      const gTests = Array.isArray(globals.tests) ? globals.tests : [];
      const gFailed = gTests.filter((x) => x && x.ok === false).length;
      const toolExec = globals.toolExec && typeof globals.toolExec === "object" ? globals.toolExec : null;
      const toolExecBadge =
        toolExec && toolExec.ok === true ? `<span class="badge">ok</span>` : toolExec && toolExec.ok === false ? `<span class="badge">failed</span>` : "";
      const failedTools = toolExec && Array.isArray(toolExec.failedTools) ? toolExec.failedTools : [];
      const failedToolsText = failedTools.length ? `${failedTools.join(",")}${toolExec && toolExec.failedToolsTruncated ? ",…" : ""}` : "";
      const badge = stReport.ok === true ? `<span class="badge">ok</span>` : `<span class="badge">failed</span>`;
      return (
        `<div class="small">result: ${badge} providers_failed=${failed}/${total} global_failed=${gFailed}/${gTests.length}</div>` +
        (toolExec
          ? `<div class="small">toolsExec: ${toolExecBadge} ${escapeHtml(String(toolExec.detail || ""))}</div>`
          : "") +
        (failedToolsText ? `<div class="small mono">failed_tools: ${escapeHtml(failedToolsText)}</div>` : "")
      );
    };

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
	          ${summarizeSelfTestReport()}
	          <textarea class="mono" id="selfTestLog" readonly style="min-height:160px;">${escapeHtml(stLogs.join("\n"))}</textarea>
	        </div>
	      </section>
	    `;

	    const headerBadges = [
	      `<span class="status-badge">schema v1</span>`,
	      runtimeEnabled ? `<span class="status-badge status-badge--success">BYOK: ON</span>` : `<span class="status-badge status-badge--warning">BYOK: OFF</span>`,
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
	            <input type="checkbox" id="runtimeEnabledToggle" ${runtimeEnabled ? "checked" : ""} />
	            <span>启用 BYOK</span>
	          </label>
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
	    const tokenBadge = tokenSet ? `<span class="status-badge status-badge--success">token: set</span>` : `<span class="status-badge status-badge--warning">token: empty</span>`;

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
	              <div class="text-muted text-xs">用于官方 upstream 路由 + <span class="text-mono">/get-models</span> 合并。</div>
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
	              <div class="text-muted text-xs">留空=不改；点击 ✕=清空（保存后生效）。</div>
	            </div>
	          </div>
	        </div>
	      </section>
	    `;

		    const providersHtml = (() => {
		      const expanded = providerExpanded && typeof providerExpanded === "object" && !Array.isArray(providerExpanded) ? providerExpanded : {};
		      const list = providers
		        .map((p, idx) => {
		          const pid = normalizeStr(p?.id);
		          const pKey = pid || `idx:${idx}`;
		          const type = normalizeStr(p?.type);
		          const baseUrl = normalizeStr(p?.baseUrl);
		          const apiKeySet = Boolean(normalizeStr(p?.apiKey));
		          const dm = normalizeStr(p?.defaultModel);
		          const rawModels = Array.isArray(p?.models) ? p.models : [];
	          const models = uniq(rawModels.filter((m) => normalizeStr(m)));
	          const modelOptions = uniq(models.concat(dm ? [dm] : []));
	          const requestDefaults = p?.requestDefaults && typeof p.requestDefaults === "object" && !Array.isArray(p.requestDefaults) ? p.requestDefaults : {};
	          const thinkingUi = (() => {
	            if (type === "openai_responses") {
	              const uiThinkingLevel = normalizeStr(requestDefaults.__byok_thinking_level);
	              const reasoning =
	                requestDefaults.reasoning && typeof requestDefaults.reasoning === "object" && !Array.isArray(requestDefaults.reasoning) ? requestDefaults.reasoning : {};
	              const raw = normalizeStr(reasoning.effort);
	              const rawNorm = raw.replace(/[\s-]+/g, "_");
	              const v =
	                rawNorm === "extra_high"
	                  ? "extra"
	                  : rawNorm === "high" && uiThinkingLevel === "extra"
	                  ? "extra"
	                  : rawNorm === "low" || rawNorm === "medium" || rawNorm === "high"
	                    ? rawNorm
	                    : rawNorm
	                      ? "custom"
	                      : "";
	              const hint =
	                v === "extra"
	                  ? "OpenAI Responses：reasoning.effort=extra_high（注意：Extra high 可能更快消耗速率/额度）"
	                  : "OpenAI Responses：reasoning.effort=low|medium|high|extra_high";
	              return { supported: true, value: v, hint };
	            }
	            if (type === "anthropic") {
	              const thinking =
	                requestDefaults.thinking && typeof requestDefaults.thinking === "object" && !Array.isArray(requestDefaults.thinking) ? requestDefaults.thinking : null;
	              const tType = normalizeStr(thinking && thinking.type);
	              const btRaw = thinking ? (thinking.budget_tokens ?? thinking.budgetTokens) : undefined;
	              const bt = Number(btRaw);
	              let v = "";
	              if (thinking) {
	                if (tType !== "enabled") v = "custom";
	                else if (bt === 1024) v = "low";
	                else if (bt === 2048) v = "medium";
	                else if (bt === 4096) v = "high";
	                else if (bt === 8192) v = "extra";
	                else v = "custom";
	              }
	              return { supported: true, value: v, hint: "Anthropic：写入 requestDefaults.thinking.budget_tokens（Low/Medium/High/Extra high）" };
	            }
	            return { supported: false, value: "", hint: "该类型不支持（可用 Defaults JSON 自定义）" };
	          })();

		          const providerTitle = pid || `provider_${idx + 1}`;
		          const isExpanded = pKey in expanded ? expanded[pKey] === true : idx === 0;
		          const headerBadges = [
		            idx === 0 ? `<span class="status-badge status-badge--success">default</span>` : "",
		            type ? `<span class="status-badge">${escapeHtml(type)}</span>` : "",
		            models.length ? `<span class="status-badge">models: ${escapeHtml(String(models.length))}</span>` : `<span class="status-badge status-badge--warning">models: 0</span>`,
		            apiKeySet ? `<span class="status-badge status-badge--success">key: set</span>` : `<span class="status-badge status-badge--warning">key: empty</span>`
		          ]
		            .filter(Boolean)
		            .join("");

		          return `
		            <div class="provider-card${isExpanded ? " is-expanded" : ""}" data-provider-card data-provider-idx="${idx}" data-provider-key="${escapeHtml(pKey)}">
		              <div class="provider-card__header" data-action="toggleProviderCard" data-idx="${idx}">
		                <div class="flex-row flex-wrap">
		                  <span class="icon-chevron">▶</span>
		                  <strong class="text-mono">${escapeHtml(providerTitle)}</strong>
	                  ${headerBadges}
	                  ${baseUrl ? `<span class="text-muted text-xs text-mono">${escapeHtml(baseUrl)}</span>` : `<span class="text-muted text-xs">baseUrl: (empty)</span>`}
	                </div>
	                <div class="flex-row flex-wrap">
	                  <button class="btn btn--small" data-action="makeProviderDefault" data-idx="${idx}" ${idx === 0 ? "disabled" : ""}>设为默认</button>
	                  <button class="btn btn--small btn--danger" data-action="removeProvider" data-idx="${idx}">删除</button>
	                </div>
	              </div>
	              <div class="provider-card__content-wrapper">
	                <div class="provider-card__body">
	                  <div class="provider-card__inner">
	                    <div class="form-grid">
	                      <div class="form-group">
	                        <label class="form-label">ID</label>
	                        <input type="text" data-p-idx="${idx}" data-p-key="id" value="${escapeHtml(pid)}" placeholder="openai" />
	                      </div>
	                      <div class="form-group">
	                        <label class="form-label">Type</label>
	                        <select data-p-idx="${idx}" data-p-key="type">
	                          ${optionHtml({ value: "openai_compatible", label: "openai_compatible", selected: type === "openai_compatible" })}
	                          ${optionHtml({ value: "openai_responses", label: "openai_responses", selected: type === "openai_responses" })}
	                          ${optionHtml({ value: "anthropic", label: "anthropic", selected: type === "anthropic" })}
	                          ${optionHtml({ value: "gemini_ai_studio", label: "gemini_ai_studio", selected: type === "gemini_ai_studio" })}
	                        </select>
	                      </div>
	                      <div class="form-group form-grid--full">
	                        <label class="form-label">Base URL</label>
	                        <input type="url" data-p-idx="${idx}" data-p-key="baseUrl" value="${escapeHtml(baseUrl)}" placeholder="https://api.openai.com/v1" />
	                      </div>
	                      <div class="form-group form-grid--full">
	                        <div class="flex-between flex-row">
	                          <label class="form-label">API Key</label>
	                          ${apiKeySet ? `<span class="status-badge status-badge--success">set</span>` : `<span class="status-badge status-badge--warning">empty</span>`}
	                        </div>
	                        <div class="flex-row">
	                          <input type="password" data-p-idx="${idx}" data-p-key="apiKeyInput" value="" placeholder="${apiKeySet ? "(set)" : "(empty)"}" />
	                          <button class="btn btn--icon btn--danger" data-action="clearProviderKey" data-idx="${idx}" title="清空 API Key">✕</button>
	                        </div>
	                      </div>
	                      <div class="form-group">
	                        <label class="form-label">Models</label>
	                        <div class="flex-row flex-wrap">
	                          <span class="status-badge">${escapeHtml(String(models.length))}</span>
	                          <button class="btn btn--small" data-action="fetchProviderModels" data-idx="${idx}">拉取</button>
	                          <button class="btn btn--small" data-action="editProviderModels" data-idx="${idx}">编辑</button>
	                        </div>
	                      </div>
	                      <div class="form-group">
	                        <label class="form-label">Default Model</label>
	                        <select data-p-idx="${idx}" data-p-key="defaultModel">
	                          ${optionHtml({ value: "", label: "(auto)", selected: !dm })}
	                          ${modelOptions.map((m) => optionHtml({ value: m, label: m, selected: dm === m })).join("")}
	                        </select>
	                      </div>
	                      <div class="form-group">
	                        <label class="form-label">思考等级</label>
	                        <select data-p-idx="${idx}" data-p-key="thinkingLevel" ${thinkingUi.supported ? "" : "disabled"}>
	                          ${optionHtml({ value: "", label: "(Default)", selected: thinkingUi.value === "" })}
	                          ${optionHtml({ value: "low", label: "Low", selected: thinkingUi.value === "low" })}
	                          ${optionHtml({ value: "medium", label: "Medium", selected: thinkingUi.value === "medium" })}
	                          ${optionHtml({ value: "high", label: "High", selected: thinkingUi.value === "high" })}
	                          ${optionHtml({ value: "extra", label: "Extra high", selected: thinkingUi.value === "extra" })}
	                          ${thinkingUi.value === "custom" ? optionHtml({ value: "custom", label: "(Custom / keep)", selected: true }) : ""}
	                        </select>
	                        <div class="text-muted text-xs">${escapeHtml(thinkingUi.hint)}</div>
	                      </div>
	                      <div class="form-group form-grid--full">
	                        <label class="form-label">Advanced</label>
	                        <div class="flex-row flex-wrap">
	                          <button class="btn btn--small" data-action="editProviderHeaders" data-idx="${idx}">Headers</button>
	                          <button class="btn btn--small" data-action="editProviderRequestDefaults" data-idx="${idx}">Defaults</button>
	                        </div>
	                      </div>
	                    </div>
	                  </div>
	                </div>
	              </div>
	            </div>
	          `;
	        })
	        .join("");

	      return `
	        <section class="settings-panel">
	          <header class="settings-panel__header">
	            <span>Providers</span>
	            <div class="flex-row flex-wrap">
	              <button class="btn btn--small btn--primary" data-action="addProvider">+ 新增 Provider</button>
	            </div>
	          </header>
	          <div class="settings-panel__body">
	            <div class="text-muted text-xs">约定：列表第 1 个（<span class="text-mono">providers[0]</span>）为默认 BYOK provider。</div>
	            <div style="height:8px;"></div>
	            <div class="provider-list">
	              ${list || `<div class="text-muted" style="text-align:center;padding:20px;">暂无 Provider，请点击右上角新增。</div>`}
	            </div>
	          </div>
	        </section>
	      `;
	    })();

    const historySummary = c.historySummary && typeof c.historySummary === "object" ? c.historySummary : {};
    const hsEnabled = historySummary.enabled === true;
    const hsProviderId = normalizeStr(historySummary.providerId);
    const hsModel = normalizeStr(historySummary.model);
    const hsByokModel = hsProviderId && hsModel ? `byok:${hsProviderId}:${hsModel}` : "";
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
	              <div class="text-muted text-xs">留空则跟随当前对话模型；候选项来自 providers[].models。</div>
	            </div>
	            <div class="form-group form-grid--full">
	              <div class="flex-row flex-wrap">
	                <button class="btn btn--small" data-action="clearHistorySummaryCache">清理摘要缓存</button>
	                <span class="text-muted text-xs">仅清理后台摘要复用缓存，不影响 UI 历史显示。</span>
	              </div>
	            </div>
	          </div>
	        </div>
	      </section>
	    `;

    const providerMap = computeProviderIndexById(c);
    const llmGroup = ENDPOINT_GROUPS_V1.find((g) => g && g.id === "llm_data_plane");
    const byokSupportedSet = new Set(Array.isArray(llmGroup?.endpoints) ? llmGroup.endpoints : []);

    const endpointGroups = ENDPOINT_GROUPS_V1.concat(
      unknownRuleEndpoints.length
        ? [{ id: "other_from_config", label: "其他（来自配置）", endpoints: unknownRuleEndpoints }]
        : []
    );

    const defaultMode = "official";
    const defaultModeLabel = "default (official)";

    const endpointGroupsHtml = endpointGroups
      .map((g) => {
        const endpoints = Array.isArray(g?.endpoints) ? g.endpoints : [];
        const overrideCount = endpoints.filter((ep) => {
          const r = rulesObj[ep] && typeof rulesObj[ep] === "object" ? rulesObj[ep] : null;
          const m = normalizeStr(r?.mode);
          return m === "official" || m === "byok" || m === "disabled";
        }).length;

        const openAttr = endpointSearchText ? " open" : overrideCount ? " open" : "";

        const rows = endpoints
          .map((ep) => {
            const r = rulesObj[ep] && typeof rulesObj[ep] === "object" ? rulesObj[ep] : {};
            const mode = normalizeStr(r.mode);
            const modeIsByok = mode === "byok";
            const providerId = normalizeStr(r.providerId);
            const model = normalizeStr(r.model);
            const models = providerId && providerMap[providerId] && Array.isArray(providerMap[providerId].models) ? providerMap[providerId].models : [];

            const providerDisabled = !modeIsByok;
            const modelDisabled = providerDisabled || !providerId;
            const modelOptions = uniq(models.concat(model ? [model] : []));

            const desc = typeof ENDPOINT_MEANINGS_V1[ep] === "string" ? ENDPOINT_MEANINGS_V1[ep] : "";
            const byokDisabled = !byokSupportedSet.has(ep) && mode !== "byok" && g.id !== "other_from_config";

            return `
              <div class="endpoint-grid endpoint-row" data-endpoint-row="${escapeHtml(ep)}" data-endpoint-desc="${escapeHtml(desc)}">
                <div class="endpoint-meta">
                  <div class="mono">${escapeHtml(ep)}</div>
                  ${desc ? `<div class="small endpoint-desc">${escapeHtml(desc)}</div>` : ``}
                </div>
                <div>
                  <select data-rule-ep="${escapeHtml(ep)}" data-rule-key="mode">
                    ${optionHtml({ value: "", label: defaultModeLabel, selected: !mode })}
                    ${optionHtml({ value: "official", label: "official", selected: mode === "official" })}
                    ${optionHtml({ value: "byok", label: byokSupportedSet.has(ep) ? "byok" : "byok (LLM only)", selected: mode === "byok", disabled: byokDisabled })}
                    ${optionHtml({ value: "disabled", label: "disabled (no-op)", selected: mode === "disabled" })}
                  </select>
                </div>
                <div>
                  <select data-rule-ep="${escapeHtml(ep)}" data-rule-key="providerId" ${providerDisabled ? `disabled title="Only used when mode=byok"` : ""}>
                    ${optionHtml({ value: "", label: "(auto / from model picker)", selected: !providerId })}
                    ${providerIds.map((id) => optionHtml({ value: id, label: id, selected: providerId === id })).join("")}
                  </select>
                </div>
                <div>
                  <select data-rule-ep="${escapeHtml(ep)}" data-rule-key="model" ${modelDisabled ? `disabled title="Pick provider first (mode=byok)"` : ""}>
                    ${optionHtml({ value: "", label: "(auto / from model picker)", selected: !model })}
                    ${modelOptions.map((m) => optionHtml({ value: m, label: m, selected: model === m })).join("")}
                  </select>
                </div>
              </div>
            `;
          })
          .join("");

        return `
	          <details class="endpoint-group" data-endpoint-group="${escapeHtml(g.id)}"${openAttr}>
	            <summary class="endpoint-group-summary">
	              <span>${escapeHtml(g.label)}</span>
	              <span class="row" style="gap:6px;">
	                <span class="badge">${escapeHtml(String(overrideCount))} overridden</span>
	                <span class="badge" data-endpoint-group-count-badge>${escapeHtml(String(endpoints.length))} total</span>
	              </span>
	            </summary>
	            <div class="endpoint-group-body">
	              <div class="endpoint-grid endpoint-grid-header small">
	                <div>endpoint</div>
                <div>mode</div>
                <div>provider</div>
                <div>model</div>
              </div>
              ${rows || `<div class="small">(empty)</div>`}
            </div>
          </details>
        `;
      })
      .join("");

	    const endpointRules = `
	      <section class="settings-panel">
	        <header class="settings-panel__header">
	          <span>Endpoint Rules</span>
	          <span class="status-badge">${escapeHtml(String(knownEndpoints.length))} endpoints</span>
	        </header>
	        <div class="settings-panel__body">
	          <div class="text-muted text-xs">统一管理 endpoint 的 Routing / Disable；未设置默认 official；仅 LLM 数据面支持 byok。</div>
	          <div style="height:10px;"></div>
	          <div class="flex-row flex-wrap" style="margin-bottom:8px;">
	            <input type="search" id="endpointSearch" value="${escapeHtml(endpointSearchText)}" placeholder="搜索 endpoint 或含义（支持子串过滤，例如 /record-、GitHub、token）" />
	            <span class="text-muted text-xs" id="endpointFilterCount"></span>
	          </div>
	          ${endpointGroupsHtml || `<div class="text-muted text-xs">(no endpoints)</div>`}
	        </div>
	      </section>
	    `;

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
              mKind === "models" ? `Edit models (Provider #${mIdx + 1})` : mKind === "headers" ? `Edit headers (Provider #${mIdx + 1})` : `Edit request_defaults (Provider #${mIdx + 1})`;
            const text =
              mKind === "models"
                ? (Array.isArray(mProvider.models) ? mProvider.models : []).join("\n")
                : JSON.stringify(mKind === "headers" ? (mProvider.headers ?? {}) : (mProvider.requestDefaults ?? {}), null, 2);
            const hint =
              mKind === "models" ? "每行一个 model id（用于下拉选择与 /get-models 注入）。" : "请输入 JSON 对象（会在 Save 时持久化）。";

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
	        ${endpointRules}
	        ${selfTestHtml}
	        <section class="settings-panel">
	          <header class="settings-panel__header">
	            <span>Summary</span>
	          </header>
	          <div class="settings-panel__body">${ns.summarizeSummaryBox(summary)}</div>
	        </section>
	      </div>
	      ${modalHtml}
	    `;
	  };
})();
