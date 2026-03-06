# Augment-BYOK（请尽快 PR 合并，避免跟不上本仓库）

单一 VSIX：把 Augment 的 **13 个 LLM 数据面端点**按路由转到 BYOK（支持 Streaming + tool use），其它端点保持官方行为；支持运行时一键回滚（无需 Rust/外部服务）。

## 安装（推荐：Releases）

- GitHub Releases（tag：`rolling`）下载 `augment.vscode-augment.*.byok.vsix`
- VS Code → Extensions → `...` → `Install from VSIX...` → Reload Window

## 快速配置（面板）

1. 运行 `BYOK: Open Config Panel`
2. 至少配置 1 个 `providers[]` → `Save`（Base URL 会按 type 自动填充默认值）
3. 运行 `BYOK: Enable`（`runtimeEnabled=true` 才会接管 13 个端点）
4. 可选：在 Model Picker 选择 `byok:<providerId>:<modelId>`（由 `/get-models` 注入）

配置存储：VS Code extension `globalState`（含 Key/Token；不参与 Sync）。字段与约束见 `docs/CONFIG.md`；示例见 `config.example.json`。

可选：面板支持 `Prompts`（按 endpoint 追加 system prompt，仅 BYOK 生效）与 `Self Test`（一键验证 models/chat/chat-stream）。

常用命令：
- `BYOK: Enable` / `BYOK: Disable (Rollback)`
- `BYOK: Reload Config`
- `BYOK: Import Config` / `BYOK: Export Config`
- `BYOK: Clear History Summary Cache`

## Provider 支持（4 类）

- `openai_compatible`：`POST {baseUrl}/chat/completions`（SSE）
- `openai_responses`：`POST {baseUrl}/responses`（SSE，支持 `incomplete_details.reason`→`stop_reason`）
- `anthropic`：`POST {baseUrl}/messages`（SSE）
- `gemini_ai_studio`：`.../v1beta/models/<model>:streamGenerateContent?alt=sse`

协议适配细节（工具/stop_reason/用量/兜底/常见网关差异）见 `docs/PROVIDERS.md`。

## 13 个端点（会被 BYOK shim 接管）

- `callApi`（6）：`/get-models`、`/chat`、`/completion`、`/chat-input-completion`、`/edit`、`/next_edit_loc`
- `callApiStream`（7）：`/chat-stream`、`/prompt-enhancer`、`/instruction-stream`、`/smart-paste-stream`、`/next-edit-stream`、`/generate-commit-message-stream`、`/generate-conversation-title`

完整端点范围（71/13）见 `docs/ENDPOINTS.md`。

## 排障（高频）

- 401/403：检查 `apiKey`/`headers`；不要把 `Bearer ` 前缀重复写入（`apiKey` 会自动加 Bearer，`headers.authorization` 则应完整填写）。
- 404/HTML：`baseUrl` 很可能少了 `/v1`（OpenAI/Anthropic 兼容端点通常要求）。
- 流式无输出：确认上游支持 `text/event-stream`；建议直接在面板跑 `Self Test` 定位（models / chat / chat-stream）。
- Anthropic stream 422 `system: invalid type: string`：多见于“Anthropic 兼容代理”实现差异；已内置 blocks 兼容兜底重试（仍失败时请确认 `baseUrl` 指向 `/messages` 且代理支持 SSE）。
- BYOK 未生效：确认已 `Save`（热更新只影响后续请求）且 `BYOK: Enable`（runtimeEnabled=true）。

## 本地构建

前置：Node.js 20+、Python 3、可访问 Marketplace

- 快速检查（不依赖上游缓存）：`npm run check:fast`
- 完整检查（需要缓存上游 VSIX）：`npm run upstream:analyze`（一次）→ `npm run check`
- 构建：`npm run build:vsix`（产物：`dist/augment.vscode-augment.<upstreamVersion>.byok.vsix`）

## 文档（索引）

- `docs/CONFIG.md`：配置/路由/字段限制（单一真相）
- `docs/PROVIDERS.md`：4 个 provider.type 的协议适配与兼容矩阵
- `docs/ENDPOINTS.md`：端点范围（71/13）
- `docs/ARCH.md`：架构/最小补丁面概览/开发约束（全量修改功能清单见下文）

## 全量修改功能（对上游 VSIX 的“全量改动面”清单）

> 说明：这里的“修改”指本仓库在构建 `*.byok.vsix` 时对上游 Augment VSIX 的补丁/替换点 + BYOK 运行时代码新增能力。  
> 状态标记：`[x]` 已实现；`[-]` 部分实现/依赖条件（条目内注明）；`[ ]` 未实现（明确不做 / 未来可能做）。

### 0) 总体目标与边界（Scope / Non-goals）

- [x] 单一 VSIX：所有能力都打包进一个 `*.vsix`，无需 Rust/外部代理服务
- [x] 最小破坏面：只接管 **13 个 LLM 数据面端点**（其余端点维持 official 或按需 disabled）
- [x] 可回滚：运行时一键回滚（`runtimeEnabled=false` 即回到官方链路）
- [x] 可审计：锁定上游版本与关键注入物的 sha256，并产出覆盖矩阵/端点全集报告
- [x] fail-fast：上游升级导致 patch needle / 合约不满足时，构建直接失败（避免 silent break）
- [x] 不依赖 `augment.advanced.*` settings：构建期移除贡献点 + 运行时不读取/不写入
- [x] 配置来源单一：只用 VS Code extension `globalState`（含 Key/Token，不参与 Sync）
- [x] 运行时开关单独存储并参与 Sync：仅 `augment-byok.runtimeEnabled.v1` 加入 Sync，方便“跨设备一键回滚”
- [ ] 非目标：复刻控制面/权限/Secrets/遥测/Remote Agents（保持官方实现；必要时可用 `disabled` 兜底）
- [ ] 非目标：autoAuth（构建期 guard 明确禁止；命中直接 fail-fast）
- [ ] 非目标：引入 env/yaml/SecretStorage 作为配置源（避免多源漂移与审计难度）

### 1) 构建与产物（Build / Artifacts）

- [x] 构建单一真相：`tools/build/build-vsix.js`
- [x] 上游 VSIX 下载/解包：下载到 `.cache/upstream/*.vsix`，解包到 `.cache/work/*`
- [x] 支持跳过下载复用缓存：`build-vsix --skip-download`
- [x] Overlay 运行时代码与 UI：把 `payload/extension/out/byok/*` 覆盖到上游 `extension/out/byok/*`
- [x] 上游 VSIX 下载/解包能力复用：`tools/lib/upstream-vsix.js`（build / analyze / contracts 共用）
- [x] BYOK patch 编排复用：`tools/lib/byok-workflow.js`（避免构建脚本与合约脚本漂移）
- [x] 产物输出：`dist/augment.vscode-augment.<upstreamVersion>.byok.vsix`
- [x] 产物锁文件（上游+注入物 sha）：`upstream.lock.json` / `dist/upstream.lock.json`
- [x] 端点覆盖报告：`dist/endpoint-coverage.report.md`（LLM 端点覆盖矩阵）
- [x] 上游端点全集分析：`.cache/reports/upstream-analysis.json`（由 `npm run upstream:analyze` 生成）
- [x] Release 资产命名去重：`dist/upstream.lock.json` 会复制为 `dist.upstream.lock.json`（仅用于 Release assets）

### 2) 构建期补丁面（Patch Surface：严格受控 & 可审计）

#### 2.1 注入拦截器（injector）

- [x] 注入方式：将拦截器 prepend 到上游 `extension/out/extension.js` 顶部
- [x] 注入来源固定：`vendor/augment-interceptor/inject-code.augment-interceptor.v1.2.txt`（byte-level 固定，不在构建期改写）
- [x] 注入脚本：`tools/patch/patch-augment-interceptor-inject.js`
- [x] 注入一致性审计：interceptor sha256 写入 `upstream.lock.json` 与 `dist/upstream.lock.json`

#### 2.2 Webview 资产外科式补丁（上游 bundle 层）

- [x] 工具卡片历史回放兜底：避免重启后历史 turn 的工具区域因 store 未恢复而空白
  - [x] patch 脚本：`tools/patch/patch-webview-tooluse-fallback.js`
  - [x] patch 目标：`common-webviews/assets/AugmentMessage-*.js`（按文件名模式匹配）
  - [-] 兼容策略：以“needle/正则”做最小替换；上游 bundle 结构大改时会 fail-fast（要求人工审查更新）
- [x] History Summary 节点瘦身：避免 Editable History 等路径对巨型节点 stringify/clone 导致内存爆炸
  - [x] patch 脚本：`tools/patch/patch-webview-history-summary-node.js`
  - [x] patch 目标：`common-webviews/assets/extension-client-context-*.js`
  - [x] 策略：把 HISTORY_SUMMARY 节点存储改为 TEXT 节点（语义保持、体积大幅下降）

#### 2.3 注入 BYOK 运行时入口（bootstrap）

- [x] 注入 bootstrap：在上游 `extension/out/extension.js` 中注入 `./byok/runtime/bootstrap`
- [x] 注入脚本：`tools/patch/patch-extension-entry.js`
- [x] bootstrap 能力：初始化配置管理、运行时开关、shim 挂载、热更新监听

#### 2.4 暴露上游少量内部对象（仅 Self Test 用）

- [x] 目的：Self Test 覆盖“真实工具执行”，需要访问上游 toolsModel / store 等内部对象
- [x] 注入脚本：`tools/patch/patch-expose-upstream.js`
- [x] 约束：仅暴露必要引用到 `globalThis`，不改变官方业务逻辑

#### 2.5 Official overrides（官方连接参数来源切换）

- [x] 目标：把官方 `completionURL/apiToken` 来源从 VS Code settings 改为 `globalState`
- [x] 注入脚本：`tools/patch/patch-official-overrides.js`
- [x] 行为：支持私有租户/官方上下文注入（token 可选；失败不影响 BYOK 主链路）

#### 2.6 模型选择器补丁（Model Picker：BYOK-only）

- [x] 目标：`runtimeEnabled=true` 时，Model Picker 只展示 `byok:*`（避免“选了官方但 BYOK 实际忽略”的错觉）
- [x] 注入脚本：`tools/patch/patch-model-picker-byok-only.js`
- [x] 行为：仅在 BYOK 开启时接管；关闭即回到官方模型合并逻辑

#### 2.7 禁用上游 chatHistory 硬裁剪（仅 BYOK 开启时）

- [x] 目标：避免客户端按轮数/体积先截断，导致 historySummary/工具结果变成“孤儿上下文”
- [x] 注入脚本：`tools/patch/patch-disable-chat-history-truncation.js`
- [-] 触发条件：仅 `runtimeEnabled=true` 时生效（关闭 BYOK 不改变官方行为）

#### 2.8 callApi / callApiStream shim（端点级接管）

- [x] 注入点：在上游 `callApi` / `callApiStream` 方法开头注入一次性拦截
- [x] 注入脚本：`tools/patch/patch-callapi-shim.js`
- [x] 约定：`maybeHandleCallApi*()` 返回 `undefined` → 回落到官方原生逻辑（软回滚关键）
- [x] 路由模式：`byok | official | disabled`

#### 2.9 package.json 补丁（命令/设置贡献点最小化）

- [x] 注入 BYOK 命令：`BYOK: Enable/Disable/Reload/Open Panel/Import/Export/Clear Cache`
- [x] 移除 `augment.advanced.*` settings 贡献点：避免误读/误写上游高级设置
- [x] 注入脚本：`tools/patch/patch-package-json-commands.js`

#### 2.10 构建期 guard + contracts（fail-fast）

- [x] `autoAuth=0` guard：构建产物中命中 `autoAuth` 字符串直接失败
  - [x] guard 脚本：`tools/patch/guard-no-autoauth.js`
- [x] `node --check`：对关键注入后的 JS 做语法检查（避免产物不可加载）
  - [x] 检查脚本：`tools/check/node-check-js.js`
- [x] BYOK 合约检查：确保 marker/运行时文件/协议枚举/模型注册 feature_flags 满足最小契约
  - [x] 合约入口：`tools/check/byok-contracts/main.js`
  - [x] 子检查：`tools/check/byok-contracts/check-callapi-shim.js`
  - [x] 子检查：`tools/check/byok-contracts/check-protocol-enums.js`
  - [x] 子检查：`tools/check/byok-contracts/check-augment-protocol-shapes.js`

### 3) 运行时开关与回滚（Runtime Toggle / Rollback）

- [x] BYOK 运行时开关存储：`augment-byok.runtimeEnabled.v1`
- [x] 配置存储：`augment-byok.config.v1`（含 Key/Token；不参与 Sync）
- [x] History Summary 缓存存储：`augment-byok.historySummaryCache.v1`（不参与 Sync）
- [x] 软回滚语义：`runtimeEnabled=false` 时 `maybeHandleCallApi*()` 直接返回 `undefined`/空 stream → 官方逻辑接管
- [x] 一键回滚命令：`BYOK: Disable (Rollback)`（不清空配置，仅切换运行时）
- [x] 一键开启命令：`BYOK: Enable`
- [x] 热更新：面板 `Save` 后对“后续请求”生效（不需要 Reload Window）
- [x] 安全回退：路由为 BYOK 但处理失败时，shim 捕获错误并回落 official（避免阻断用户）

### 4) 配置系统（globalState v1：字段/限制/兼容）

#### 4.1 配置入口与编辑体验

- [x] Webview 面板：`BYOK: Open Config Panel`
- [x] 面板保活：`retainContextWhenHidden=true`（减少频繁重建导致的状态丢失）
- [x] 仅允许加载本地资源：`localResourceRoots=[out/byok/ui/config-panel]`
- [x] 面板支持 `Reload`：丢弃未保存修改，回到 last-good config
- [x] 面板状态提示：保存/导入/导出/自检结果会推送到 UI status 区

#### 4.2 Import / Export（JSON）

- [x] `BYOK: Export Config`（可选脱敏/包含 secrets）
  - [x] Export：`include secrets`（用于备份/迁移）
  - [x] Export：`redact secrets`（敏感字段替换为 `<redacted>`，用于分享模板）
- [x] `BYOK: Import Config`（可选 merge/replace）
  - [x] Import：`Merge (preserve existing secrets)`（导入但保留当前已存密钥：当导入字段为空或 `<redacted>`）
  - [x] Import：`Replace (overwrite everything)`（完全覆盖，密钥也会被覆盖/清空）

#### 4.3 字段规范与兼容策略

- [x] 配置版本：`version=1`
- [x] 字段命名严格 camelCase（v1 不再兼容旧别名：如 `base_url` / `history_summary` 等）
- [x] 配置归一化：endpoint key 归一化为 pathname（例如 `"/chat-stream?x=1"` → `"/chat-stream"`）
- [x] 防原型污染：拒绝/过滤 `__proto__` / `prototype` / `constructor` 等不安全 key（配置与 UI 消息均做 hasOwnProperty 防护）
- [x] BYOK 内部字段隔离：`requestDefaults` 中的 BYOK 内部 key 会在发往上游前剥离（避免污染上游请求）

#### 4.4 Official 连接（仅用于：/get-models 合并 + 官方上下文注入）

- [x] `official.completionUrl`：默认 `https://api.augmentcode.com/`（可切私有租户）
- [-] `official.apiToken`：可空（无 token 时，官方上下文注入可能失败，但 BYOK 生成不受影响）

#### 4.5 providers[]（BYOK 上游列表）

- [x] 至少 1 个 provider 才能 `mode=byok` 生效
- [x] provider 基本字段：`id` / `type` / `baseUrl` / `models[]` / `defaultModel` / `apiKey?` / `headers?` / `requestDefaults?`
- [x] providerId 语义：model id 形如 `byok:<providerId>:<modelId>`
- [x] provider types（生成单一真相，见 `tools/gen/sync-provider-types.js`）：
  - [x] `openai_compatible`
  - [x] `openai_responses`
  - [x] `anthropic`
  - [x] `gemini_ai_studio`

#### 4.6 routing.rules（端点路由规则）

- [x] 规则结构：`routing.rules[endpoint]={ mode, providerId?, model? }`
- [x] `mode=byok`：走 BYOK（仅对 13 个 LLM 数据面端点提供语义实现）
- [x] `mode=official`：强制走官方（即使 runtimeEnabled=true 也不接管）
- [x] `mode=disabled`：直接 no-op（callApi 返回 `{}`，callApiStream 返回空 stream）
- [-] 规则合并：用户 rules 与默认 rules 合并；不建议手填未知端点（上游升级可能改变集合）

#### 4.7 prompts（按 endpoint 追加 system prompt，仅 BYOK 生效）

- [x] `prompts.endpointSystem[endpoint]`：按端点追加 system prompt
- [x] 生效范围：仅 BYOK（runtimeEnabled=true 且 endpoint 走 byok 路由）
- [x] 注入位置：保证“输出约束类 system prompt”仍保持在最后（避免破坏上游格式约束）
- [x] 面板提供“一键填充（推荐）”模板（覆盖当前 endpointSystem；建议先 Export 备份）

#### 4.8 输出上限（max tokens 自动推断）

- [x] 当 `providers[].requestDefaults` 未配置任何 max tokens 字段时：BYOK 会自动注入 `max_output_tokens`
- [x] 推断策略：按 model 名称推断上下文窗口大小 + 估算 prompt 体积，尽可能给出“不会轻易截断”的输出预算（并预留安全余量）
- [x] 兼容不同 provider：以 `max_output_tokens` 为 canonical，provider 映射层会转换到各自字段（例如 Gemini 的 `generationConfig.maxOutputTokens`）
- [x] 若触发 token-limit 重试：会强制覆盖所有 max tokens 别名 key（含 `generationConfig.maxOutputTokens`），避免不同映射优先级绕过
- [x] 上游拒绝（token limit/context length）时：自动缩小 max tokens 并重试（流式仅在未输出任何 chunk 时允许重试，避免重复输出）

#### 4.9 historySummary（滚动摘要：上下文压缩）

- [x] `historySummary.enabled`：默认 false（显式开启才生效）
- [-] `historySummary.providerId/model`：可空（仅控制“摘要生成模型”；为空时 fallback 到当前 provider/model）
- [x] 触发体积：`history + message + prefix/selected_code/suffix/diff`（UTF-8 bytes）
- [x] 触发阈值：`triggerOnHistorySizeChars`（默认 800000）
- [x] 触发策略：`triggerStrategy=auto|ratio|chars`（推荐 `auto`）
- [x] 比例阈值：`triggerOnContextRatio` / `targetContextRatio`（默认约 0.70 / 0.55，触发阈值自动钳制在 0.60~0.80）
- [x] 上下文窗口估算：`contextWindowTokensDefault` / `contextWindowTokensOverrides`（override：最长子串、大小写不敏感）
- [x] 双模型解耦：触发窗口按当前对话模型判定；summary provider/model 仅用于“如何生成摘要”
- [x] 常见 overrides：`gpt-5.3-codex=400000`、`gpt-5.2=400000`、`claude-4.6-opus=1000000`、`gemini-3-pro=1000000`、`kimi-k2=128000`
- [x] Tail 保留：`historyTailSizeCharsToExclude`（按 UTF-8 bytes 估算）+ `minTailExchanges`
- [x] 切分一致性：触发后不再被“仅 history 阈值”二次否决（避免触发但不注入）
- [x] 摘要生成上限：`maxTokens` / `timeoutSeconds` / `maxSummarizationInputChars`（按 UTF-8 bytes 估算）
- [x] rolling summary 缓存：`rollingSummary=true` + `cacheTtlMs`（对话维度缓存，减少重复 summarization）
- [x] 刷新策略：仅“当前请求已含 summary node”才跳过；`chat_history` 含旧 summary 仍允许刷新
- [x] 提供默认 supervisor prompt 模板：`summaryNodeRequestMessageTemplate` + `abridgedHistoryParams`
- [x] 兜底：summary 生成失败/超时/未配置时，仍会注入 fallback summary 强制压缩（避免请求过大导致直接失败）
- [x] 兜底：`end_part_full` 中的 `tool_result` / `tool_use input` 会中间截断（保留尾部引用 id），防止单个工具输出撑爆上下文

### 5) 端点覆盖（71 / 13）与路由策略

#### 5.1 端点全集与覆盖矩阵

- [x] 上游端点全集：`npm run upstream:analyze` → `.cache/reports/upstream-analysis.json`
- [x] LLM 覆盖矩阵：`npm run report:coverage` → `dist/endpoint-coverage.report.md`
- [x] 端点文档：`docs/ENDPOINTS.md`

#### 5.2 13 个 LLM 数据面端点（BYOK 语义实现）

- [x] `callApi`（6）：`/get-models`、`/chat`、`/completion`、`/chat-input-completion`、`/edit`、`/next_edit_loc`
- [x] `callApiStream`（7）：`/chat-stream`、`/prompt-enhancer`、`/instruction-stream`、`/smart-paste-stream`、`/next-edit-stream`、`/generate-commit-message-stream`、`/generate-conversation-title`
- [x] 单一真相维护：`tools/report/llm-endpoints-spec.js`
- [x] 自动生成同步：`npm run gen:llm-endpoints`（更新 `docs/ENDPOINTS.md` + UI + 默认 routing rules）

#### 5.3 其余 58 个端点（默认 official / 按需 disabled）

- [ ] Remote Agents（15）：不接管（依赖控制面/权限/状态机），默认 official
- [ ] Agents / Tools（6）：不接管（远程工具路由），默认 official
- [ ] 文件/Blob/上下文同步（7）：不接管（依赖官方存储/鉴权），默认 official
- [ ] GitHub（4）：不接管（依赖官方账号/权限），默认 official
- [ ] 账号/订阅/权限/Secrets（7）：不接管（其中 `/user-secrets/*` 默认 disabled），其余默认 official
- [ ] 反馈/遥测/调试（17）：不接管（部分默认 disabled，少量保持 official）
- [ ] 通知（2）：不接管（默认 official）

### 6) callApi（非流式）实现细目（6）

#### 6.1 `/get-models`（模型注册 + feature_flags 注入）

- [x] 从 BYOK 配置构建 byok models：`providers[].models` → `byok:<providerId>:<modelId>`
- [x] 默认模型选择：优先 `providers[0]` / 其 defaultModel（否则回退 `"unknown"`）
- [-] 尝试调用官方 `/get-models` 获取基础 flags（用于兼容上游 model registry）
- [x] scrub 官方 `feature_flags` 中的 model registry 相关字段（避免冲突/双注册）
- [x] 注入 model registry feature_flags（确保上游 Model Picker/feature gate 正常）
- [x] 注入 `models[]`：仅返回 `byok:*`（runtimeEnabled=true 时避免“官方模型混入”的困惑）
- [-] 官方调用失败兜底：回退到本地 `byok models` 列表（不中断）

#### 6.2 `/chat`（Augment chat → provider chat，非流式）

- [x] 解析 Augment chat 请求体（message/chat_history/nodes/tool_definitions 等）
- [x] 注入 endpoint 级额外 system prompt：`prompts.endpointSystem["/chat"]`
- [-] 尝试注入官方上下文（失败忽略）：codebase-retrieval / external sources / context canvas
- [-] 可选 historySummary：在触发阈值时自动压缩 chat_history（失败忽略）
- [x] 支持 asset/checkpoint hydrate：需要时从上游拉取图片/文件/检查点（失败忽略）
- [x] 输出补充：`checkpoint_not_found` / `workspace_file_chunks`（供 UI/上游侧使用）

#### 6.3 `/completion`（文本补全）

- [x] 统一消息构造：`buildMessagesForEndpoint("/completion", body, cfg)`
- [x] provider 文本完成：`completeTextByProviderType()`（跨 provider 统一接口）
- [x] 结果封装为 Augment completion 结果结构（兼容上游 transform）

#### 6.4 `/chat-input-completion`（输入框补全）

- [x] 语义同 `/completion`（共用同一实现）
- [x] 可通过 `prompts.endpointSystem["/chat-input-completion"]` 做差异化偏好（仅 BYOK）

#### 6.5 `/edit`（编辑：输出必须符合上游约束）

- [x] 统一消息构造：`buildMessagesForEndpoint("/edit", body, cfg)`
- [x] 结果封装为 `{ text: ... }`（兼容上游 edit 结果）
- [-] 建议在 `prompts.endpointSystem["/edit"]` 强化“只输出代码”类约束（避免解释）

#### 6.6 `/next_edit_loc`（下一处编辑位置：LLM 候选 + baseline 合并）

- [x] baseline：从请求/上游能力中提取候选（若有）
- [-] LLM 候选：通过 provider 完成文本 → 解析 JSON 候选 → 与 baseline 合并
- [x] 最大候选数限制：上限 6（避免模型输出过大）
- [-] 失败兜底：LLM 失败/解析失败 → 回退 baseline（不中断）
- [-] 可选 workspace blob 注入：当缺少必要上下文时按 pathHint 拉取 workspace 内容辅助定位

### 7) callApiStream（流式）实现细目（7）

#### 7.1 `/chat-stream`（NDJSON：Augment chat chunks）

- [x] 上游协议对齐：输出为 Augment chat chunk（包含 nodes / stop_reason / final chunk）
- [x] provider stream：`streamAugmentChatChunksByProviderType()`（按 provider.type 分发）
- [x] tool meta：从 `tool_definitions` 构建 meta（用于工具卡片标题/分组/展示）
- [-] 支持 `support_tool_use_start`：根据 `feature_detection_flags` 决定发 TOOL_USE_START 还是 TOOL_USE
- [-] 支持并行工具：根据 `feature_detection_flags` 决定是否允许 parallel tool calls（OpenAI 侧会自动兜底）
- [x] thinking/reasoning：尽可能聚合为 THINKING 节点（provider 支持则透传）
- [x] token usage：尽可能输出 TOKEN_USAGE 节点（provider 支持则透传）
- [x] max tokens：未配置时自动推断注入；上游拒绝时自动缩小并重试（仅在未输出 chunk 时重试）
- [x] 输出补充：`checkpoint_not_found` / `workspace_file_chunks`（仅首 chunk 注入一次）
- [x] 流式安全网：`guardObjectStream()` 将异常转换为可读错误 chunk（避免 UI 卡死）

#### 7.2 `/prompt-enhancer`（流式：chat_result delta 包装）

- [x] 复用 provider 文本 stream：`streamTextDeltasByProviderType()`
- [x] 输出结构：把 delta 包装为 `{ text: delta, nodes: [] }` 的 chat_result 结构
- [-] 适配不同 provider 的 SSE/JSON：content-type=JSON 时自动走 JSON 解析路径

#### 7.3 `/generate-conversation-title`（流式：chat_result delta 包装）

- [x] 语义同 `/prompt-enhancer`（同一实现）
- [-] 可通过 `prompts.endpointSystem["/generate-conversation-title"]` 约束输出格式（仅 BYOK）

#### 7.4 `/instruction-stream`（流式：replacement_text）

- [x] 首 chunk 先输出 meta（replacement_id / language 等上游所需字段）
- [x] 后续 delta 同步写入 `text` 与 `replacement_text`（上游可直接 apply）
- [-] 出错兜底：返回携带 meta 的错误文本（不中断整个流式会话）

#### 7.5 `/smart-paste-stream`（流式：replacement_text）

- [x] 语义同 `/instruction-stream`（同一实现）
- [-] 可用 `prompts.endpointSystem["/smart-paste-stream"]` 做粘贴更保守/更一致的偏好（仅 BYOK）

#### 7.6 `/generate-commit-message-stream`（流式：chat_result delta 包装）

- [x] 语义同 `/prompt-enhancer`（同一实现）
- [-] 推荐配 `prompts.endpointSystem["/generate-commit-message-stream"]` 强约束输出（英文单行、无句号等）

#### 7.7 `/next-edit-stream`（伪流式：一次性生成 next edit chunk）

- [x] 若请求缺 prefix/suffix：自动从 workspace blob 补齐上下文（pathHint + blobNameHint）
- [x] 调用 provider 非流式 complete：一次性生成 `suggestedCode`
- [x] 输出结构：`makeBackNextEditGenerationChunk({ path, blobName, charStart, charEnd, existingCode, suggestedCode })`
- [-] 当前实现为单 chunk（不做逐 token streaming），但保持 stream 接口兼容上游调用方式

### 8) Provider 支持矩阵（上游 LLM 兼容层）

#### 8.1 通用能力（跨 provider）

- [x] 统一入口：按 `provider.type` 分发（避免 chat/stream/self-test/historySummary 漂移）
- [x] SSE 解析器：`providers/sse.js` + `providers/sse-json.js`（统一 JSON.parse/事件类型/统计）
- [x] HTTP util：`providers/http.js`（baseUrl join、请求构造）
- [x] 重试与错误提取：`providers/request-util.js`（`fetchOkWithRetry` + error message extraction）
- [x] requestDefaults 归一化/清理：`providers/request-defaults-util.js`（max tokens 别名归一/剥离不支持字段）
- [x] 工具/usage/final chunk 构建统一：`providers/chat-chunks-util.js`（nodeId 递增规则、stop_reason 统一）
- [x] invalid request 兜底：400/422 时自动降级请求（尽量缩到最小可用）

#### 8.2 `openai_compatible`（OpenAI Chat Completions 兼容）

- [x] 请求路径：`POST <baseUrl>/chat/completions`
- [x] 鉴权：`apiKey` 自动注入 `Authorization: Bearer <token>`（避免重复写 `Bearer `）
- [-] 支持额外 headers：`providers[].headers`（例如代理网关自定义鉴权）
- [x] 非流式文本：从 `choices[0].message.content` / `choices[0].text` 提取
- [x] 流式文本：解析 SSE `choices[0].delta.content`（doneData=`[DONE]`）
- [x] chat-stream：把 SSE delta 转为 Augment `RAW_RESPONSE` 节点（逐 chunk）
- [-] tool calls：支持 `delta.tool_calls[]` 与旧式 `delta.function_call`（自动聚合 arguments）
- [x] 并行工具兜底：当 `supportParallelToolUse` 不为 true 且存在 tools 时，自动注入 `parallel_tool_calls=false`（并兼容 `parallelToolCalls`）
- [-] tools 兼容降级链：tools → 关闭 include_usage → 关闭 tool_choice → minimal defaults → functions → no-tools
- [-] vision/多段 content 兼容：不支持 multipart 的网关自动压平为纯文本（并提示省略非文本部分）
- [x] thinking/reasoning 透传：聚合 `reasoning|thinking` 字段为 THINKING 节点（若上游提供）
- [-] token usage 透传：支持 `usage.prompt_tokens / completion_tokens` + cached/creation tokens（若上游提供）
- [x] stop_reason 统一：将 OpenAI finish_reason 映射到 Augment stop_reason，并产出 final chunk

#### 8.3 `openai_responses`（OpenAI Responses API 兼容）

- [x] 请求路径：`POST <baseUrl>/responses`
- [x] 鉴权：同 OpenAI（Bearer）+ 允许自定义 headers
- [x] 输入构造：把 Augment chat 转为 responses `instructions + input[]`
  - [x] 用户文本：`input_text`
  - [x] 用户图片：`input_image`（data URL：`data:<mime>;base64,<data>`）
  - [x] 工具调用：`function_call`（call_id/name/arguments）
  - [x] 工具结果：`function_call_output`（call_id/output）
- [-] tool pairing 修复：自动注入缺失 tool_result / 转换 orphan tool_result（保证上下游成对）
- [x] 非流式文本：从 `output_text`/`output[]` 提取（无文本会报可解释错误）
- [-] 非流式兜底：部分网关即使 `stream=false` 也只支持 SSE → 自动走一次 stream fallback 拼接文本
- [x] 流式文本：解析 SSE `response.output_text.delta` / `response.output_text.done`
- [x] chat-stream：解析 responses SSE 并输出 Augment chunks（RAW_RESPONSE/THINKING/TOOL_USE/TOKEN_USAGE/final）
- [x] `status=incomplete` + `incomplete_details.reason`：映射为 Augment stop_reason（`max_output_tokens`→MAX_TOKENS；`content_filter`→SAFETY；其余→UNSPECIFIED）
- [x] 结束兜底：`response.completed`/final JSON 到来时补齐未完整输出的尾部文本（兼容部分网关缺失 done 事件）
- [x] 工具 schema 严格化：补齐 `additionalProperties=false`；对象 schema 的 `required` 强制覆盖全部 `properties`（Responses 对 schema 更严格）

#### 8.4 `anthropic`（Anthropic Messages API 兼容）

- [x] 请求路径：`POST <baseUrl>/messages`
- [x] 鉴权：默认 `x-api-key: <token>`（也可用 headers.authorization 显式覆盖）
- [x] 非流式文本：从 `content[].type=text` 提取
- [x] 流式文本：解析 SSE `content_block_delta(text_delta)`（直到 `message_stop`）
- [-] tool blocks 兼容：遇到 tool_result/tool_use block 会在必要时剥离/压平（提升代理兼容性）
- [-] image blocks 兼容：不支持多模态的代理会剥离 image blocks（placeholder=`[image omitted]`）
- [-] tool_choice 兼容：失败时自动重试“无 tool_choice”→“无 tools + strip blocks”
- [x] `input_json_delta`：聚合 tool input JSON，并在 block_stop 时输出 TOOL_USE chunks
- [x] thinking blocks：聚合 `thinking_delta` 并输出 THINKING 节点
- [-] 422 `system: invalid type: string` 兜底：自动把 system/messages.content 转成 blocks 形式再重试（兼容部分代理差异）
- [-] token usage：支持 `usage.input_tokens/output_tokens` + cache_read/cache_creation（若上游提供）

#### 8.5 `gemini_ai_studio`（Google Generative Language API / AI Studio 兼容）

- [x] 请求路径：`<baseUrl>/v1beta/models/<model>:generateContent`
- [x] 流式请求：`...:streamGenerateContent?alt=sse`
- [x] 鉴权：`apiKey` 默认写入 query `?key=...`（也允许 headers 覆盖）
- [x] requestDefaults 归一：`max_tokens/max_output_tokens/...` → `generationConfig.maxOutputTokens`
- [x] 非流式文本：从 `candidates[0].content.parts[].text` 提取
- [x] 流式文本：Gemini 常返回“累积全文”，用 delta 方式只输出新增文本（避免重复）
- [x] functionCall：解析 `parts[].functionCall` 并输出 TOOL_USE chunks（优先用 `functionCall.id` 作为 `tool_use_id`，并按 id 去重）
- [x] tool results：把 tool_result 归一为 `functionResponse` parts（透传 `tool_use_id`→`functionResponse.id`，并做 orphan/缺失兜底）
- [-] image inlineData：支持 `parts[].inlineData`；不兼容时自动剥离并用 placeholder 代替
- [x] stop_reason：从 candidate `finishReason` 映射为 Augment stop_reason（未知值默认 END_TURN）
- [-] token usage：解析 usage 字段并输出 TOKEN_USAGE（若上游提供）

### 9) Augment Chat 协议对齐（请求/响应节点）

#### 9.1 请求节点（Request Nodes）支持（输入侧）

- [x] TEXT：把用户/系统文本归一为 provider 输入
- [x] TOOL_RESULT：把工具执行结果注入到 provider 输入（并做摘要/截断兜底）
- [x] IMAGE：把图片（base64+format）转换为各 provider 的 image part/block（或降级省略）
- [x] IMAGE_ID：当只给了 image_id（无 bytes）时，降级为 prompt 文字提示（避免阻断）
- [x] CHECKPOINT_REF：需要时从上游 hydrate（找不到则标记 checkpoint_not_found）
- [x] FILE / FILE_ID：需要时从上游 hydrate（用于把文件内容注入模型上下文）
- [x] HISTORY_SUMMARY：支持将 summary node 渲染为 supervisor 文本（并把 tool_results 合并到 end_part_full）

#### 9.2 响应节点（Response Nodes）构建（输出侧）

- [x] RAW_RESPONSE：逐 delta 输出文本（chat-stream）
- [-] THINKING：provider 支持时输出 thinking/reasoning summary（用于 UI/调试）
- [-] TOOL_USE / TOOL_USE_START：provider 支持工具调用时输出（由 feature_detection_flags 决定 start/full）
- [-] TOKEN_USAGE：provider 支持 usage 统计时输出（含 cache tokens）
- [x] FINAL：统一输出最终 chunk（stop_reason/endedCleanly/tool_use 相关约束）

### 10) Prompts：按端点追加 system prompt（仅 BYOK 上游）

- [x] 作用域隔离：只影响发往 BYOK provider 的 system prompt，不影响官方链路
- [x] endpoint key 归一化：只看 pathname（避免 query 参数导致“同端点多份 prompt”）
- [x] chat 类端点：拼接到 system prompt（与 user_guidelines/workspace_guidelines 同级）
- [x] 非 chat 类端点：拼接到 BYOK purpose system prompt（保证格式约束仍在最后）
- [x] 推荐策略：语言/风格等“全局偏好”用 Augment 自带 Guidelines；BYOK prompts 只做端点差异化

### 11) 官方上下文注入（仅 /chat、/chat-stream）

- [x] 注入入口：BYOK chat 在构造 provider 请求前，尝试调用官方能力补充外部上下文
- [-] 注入工具：`agents/codebase-retrieval`
- [-] 注入工具：`get-implicit-external-sources`
- [-] 注入工具：`search-external-sources`
- [-] 注入工具：`context-canvas/list`
- [-] 失败策略：任何注入失败都 **忽略并继续 BYOK 生成**（不把失败扩散到用户体验）
- [-] 关闭方式：请求体 `disable_retrieval=true` 或 `disableRetrieval=true`

### 12) History Summary（滚动摘要：上下文压缩）实现细目

- [x] 触发前置条件：`historySummary.enabled=true` 且有 `conversation_id` 且 chat_history 非空
- [x] 防重复：仅当前 request 已包含 summary node 时跳过；history 中已有旧 summary 仍可刷新
- [x] 触发决策：支持 `chars` / `ratio` / `auto`（auto 会结合上下文窗口估算）
- [x] 触发体积口径：`history + message + prefix/selected_code/suffix/diff`（UTF-8 bytes）
- [x] 上下文窗口基准模型：优先使用“当前对话模型”（requestedModel；缺失时回退当前请求实际 model），与 summary 生成模型解耦
- [x] 上下文窗口估算（inference）：按编程模型名启发式推断（Claude4 / GPT5 / Gemini2.5-3 / Kimi）
- [x] 覆盖优先级：`contextWindowTokensOverrides`（按 model 子串最长匹配，大小写不敏感）> `contextWindowTokensDefault` > 推断值
- [x] 常见覆盖参考：`gpt-5.3-codex=400000`、`gpt-5.2=400000`、`claude-4.6-opus=1000000`、`gemini-2.5-pro=1000000`、`gemini-3-flash=1000000`、`kimi-k2=128000`
- [x] Tail 选择：保留末尾 `historyTailSizeCharsToExclude` bytes（UTF-8 估算）+ 至少 `minTailExchanges` 个 exchanges
- [x] 切分一致性：触发后不再被“仅 history 总量”二次否决
- [x] Abridged middle：按 `abridgedHistoryParams` 输出“中段摘要”，降低 token 成本
- [x] Summary supervisor 模板：`summaryNodeRequestMessageTemplate` 支持 `{summary}/{end_part_full}` 等占位符
- [-] rolling summary cache：对话维度缓存（当上游裁剪导致 summary exchange 消失时可补回早期上下文）
- [-] Editable History 兼容：检测到 checkpoint 注入 user-modified changes 时，自动失效该对话的 summary cache
- [x] 一键清缓存：`BYOK: Clear History Summary Cache`
- [x] 兜底：summary 生成失败时仍会注入 fallback summary（保证压缩路径可用）
- [x] 兜底：`end_part_full` 中的 `tool_result` / `tool_use input` 会做中间截断，避免上下文爆炸

### 13) Workspace/Upstream 数据补齐（assets/checkpoints/文件片段）

- [x] asset hydrate：当请求仅给了 `image_id` / `file_id` 时，尝试从上游资产管理器拉取 bytes（失败忽略）
- [x] checkpoint hydrate：当请求引用 checkpoint 时，尝试从上游 checkpointManager 拉取内容
- [x] checkpoint_not_found：找不到 checkpoint 时在输出中标记（便于 UI/上游提示）
- [-] workspace_file_chunks：从请求中提取可用 workspace file chunks（maxChunks=80），并随响应返回

### 14) Self Test（面板一键自检：models/chat/chat-stream + 工具实测）

- [x] Self Test 入口：面板点击即可运行（支持日志流式输出）
- [x] provider 连通性测试：models / complete / stream（按 providerId 逐个测）
- [x] tool_definitions 捕获：优先用最近一次真实会话捕获；为空则尝试从上游 toolsModel 拉取“真实工具全集”
- [-] 工具 schema 可采样性检查：确保能生成 sample（验证 schema 合法性/可 JSON 化）
- [-] Responses strict schema 检查：确保 openai_responses 的工具 schema 满足严格约束（additionalProperties=false 等）
- [-] 真实工具 roundtrip：通过上游 toolsModel 做一次真实执行（会有副作用：文件/网络/浏览器等，按环境可用性决定）
- [-] historySummary 自检：用可用 provider 生成一次摘要（验证触发/模板/注入链路）

### 15) Hardening / 安全与稳定性

- [x] 日志脱敏：永不输出 key/token 全文（`infra/log.js` 递归 redact：authorization/apiKey/apiToken/encrypted_data 等）
- [x] 配置反原型污染：过滤不安全 key（`config/normalize-config.js`）
- [x] Webview 最小权限：仅本地资源根 + `enableScripts`（不引入远程加载）
- [x] 错误可诊断：关键链路带 trace label（endpoint/provider/model/requestId），并尽量输出可读错误文本
- [x] 流式安全兜底：异常被包装为可渲染的 error chunk（避免 UI 无输出/卡住）

### 16) CI / Release（rolling + 增量审查）

- [x] rolling release：push 默认分支自动构建并更新 `rolling` tag 的 Release
- [x] upstream-check：定时拉取最新上游 VSIX，版本变化则 PR 更新 `upstream.lock.json`
- [x] 审计入口：`upstream.lock.json` / `dist/upstream.lock.json` / `dist/endpoint-coverage.report.md`
- [x] fail-fast：patch needle 缺失 / 命中 autoAuth / 合约失败 / LLM 端点 spec 漂移 / provider types 生成结果未提交

### 17) 待优化 / 规划（来自 `docs/ROADMAP.md`）

- [ ] 去重复：进一步收敛 upstream discovery / util 逻辑（收益：减少漂移点）
- [ ] 质量闸门：补更多纯函数单测 + 低成本“未引用/仅导出未使用”清理
- [ ] 体验（可选）：面板就地校验、故障速查更精简
