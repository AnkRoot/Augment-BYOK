# CONFIG（v1）

单一真相：VS Code extension `globalState` 的 `augment-byok.config.v1`（可通过面板编辑；支持 JSON 导入/导出）。

## 快速开始（面板）

1) 运行 `BYOK: Open Config Panel`  
2) 填 `Official`：`completionUrl`（默认官方）+ `apiToken`（可选：私有租户 / 官方上下文注入）  
3) 至少配置 1 个 `providers[]`（`id/type/baseUrl/models/defaultModel`；Base URL 面板会按 type 自动填充默认值）  
4) 可选：配置 `Prompts`（按 endpoint 追加 system prompt）  
5) 点 `Save` 后对“后续请求”生效；要让 BYOK 接管请 `BYOK: Enable`（runtimeEnabled=true）

参考示例：仓库根目录 `config.example.json`（仅示例；不会自动导入到面板）。

## 存储 keys

- `augment-byok.config.v1`：配置（含 Key/Token；不参与 Sync）
- `augment-byok.runtimeEnabled.v1`：运行时开关（唯一加入 Sync；关闭=回滚 official）
- `augment-byok.historySummaryCache.v1`：历史摘要缓存（不参与 Sync）

## 命令

- `BYOK: Open Config Panel`：打开配置面板
- `BYOK: Reload Config`：重新加载配置（丢弃未保存修改）
- `BYOK: Enable` / `BYOK: Disable (Rollback)`：切换运行时（不改配置）
- `BYOK: Import Config`：从 JSON 文件导入（可选 merge 保留现有密钥）
- `BYOK: Export Config`：导出到 JSON 文件（可选包含或脱敏密钥）
- `BYOK: Clear History Summary Cache`：清理后台摘要缓存

## Import / Export（JSON）

- Export
  - `include secrets`：包含 `apiToken/apiKey/authorization` 等敏感字段（用于备份/迁移）
  - `redact secrets`：敏感字段替换为 `<redacted>`（用于分享模板）
- Import
  - `Merge (preserve existing secrets)`：导入配置但“保留当前已存密钥”（当导入文件对应字段为空或 `<redacted>`）
  - `Replace (overwrite everything)`：完全覆盖当前配置（密钥也会被覆盖/清空）

## 配置结构（概要）

注意：配置字段名严格为 **camelCase**（v1）。不再兼容历史别名/旧字段（例如 `telemetry.disabledEndpoints`、`history_summary`、`base_url` 等）。如需迁移，请参考 `config.example.json` 手动调整后再导入。

- `version`：当前为 `1`
- `official`：官方连接（仅用于 `/get-models` 合并 + 官方上下文注入）
  - `completionUrl`
  - `apiToken`
- `providers[]`：BYOK 上游列表（至少 1 个）
  - `id`：provider 标识（model id 形如 `byok:<providerId>:<modelId>`）
  - `type`：
    <!-- BEGIN GENERATED: PROVIDER_TYPES -->
    `openai_compatible` | `openai_responses` | `anthropic` | `gemini_ai_studio`
    <!-- END GENERATED: PROVIDER_TYPES -->
  - `baseUrl`
  - `apiKey`：可空（若 `headers` 已提供鉴权）
  - `headers`：额外请求头（对象）
  - `models`：model 列表（用于下拉选择与 `/get-models` 注入）
  - `defaultModel`：默认 model
  - `requestDefaults`：按 provider.type 做兼容/过滤（见下文）
- `routing.rules[endpoint]`：路由规则（与内置默认规则合并）
  - `mode`: `official | byok | disabled`
  - `providerId` / `model`：仅在 `mode=byok` 时使用（留空则默认 `providers[0]` / defaultModel）
- `prompts`：多功能提示词（追加到 system prompt；仅对 BYOK 生效）
  - `endpointSystem[endpoint]`：按 endpoint 追加（例如 `/chat`、`/chat-stream`、`/edit`…；留空=不追加）
- `historySummary`：历史摘要（自动压缩上下文，避免溢出；仅影响发给上游模型的内容）
  - 面板显式暴露：`enabled` + `byok model` 选择（保存时映射为 `providerId` + `model`，仅用于“生成摘要”）
  - 面板 Advanced：
    - `prompt`
    - `triggerStrategy` / `triggerOnContextRatio` / `targetContextRatio` / `triggerOnHistorySizeChars`
    - `historyTailSizeCharsToExclude` / `minTailExchanges`
    - `maxTokens` / `timeoutSeconds` / `maxSummarizationInputChars`
    - `rollingSummary` / `cacheTtlMs`
    - `contextWindowTokensDefault` / `contextWindowTokensOverrides(JSON)`
    - 仍建议在 JSON 中维护的重度字段：`summaryNodeRequestMessageTemplate` / `abridgedHistoryParams`
  - 触发判定（Advanced/JSON）
    - `triggerStrategy`：`auto | ratio | chars`（推荐 `auto`）
    - `triggerOnContextRatio` / `targetContextRatio`：上下文占比触发与目标（`auto/ratio` 生效；默认约 70% 触发，目标约 55%）
    - `triggerOnHistorySizeChars`：chars 基准阈值（`chars` 直接使用；`auto/ratio` 在无法推断上下文窗口时回退）
    - 触发体积按 `history + message + prefix/selected_code/suffix/diff` 统一估算（UTF-8 bytes）
    - 上下文窗口基准模型：优先当前对话模型 `requestedModel`（缺失时回退本次请求模型），与 `historySummary.model` 解耦
    - `contextWindowTokensOverrides` / `contextWindowTokensDefault`：模型窗口覆盖；`overrides` 按**最长子串、大小写不敏感**匹配
    - 默认已内置编程模型族：Claude 4.x（Sonnet/Opus）、GPT-5.x（含 5.3-codex / max）、Gemini 2.5/3（Pro/Flash）、Kimi
    - 常见 `contextWindowTokensOverrides` 示例：`gpt-5.3-codex=400000`、`gpt-5.2=400000`、`claude-4.6-opus=1000000`、`gemini-3-pro=1000000`、`kimi-k2=128000`
  - Tail 切分与注入
    - `historyTailSizeCharsToExclude`：尾部原文预算（进入 `{end_part_full}`）
    - `minTailExchanges`：最少保留尾部轮次（防止 tool_result 孤儿）
    - 一旦触发，不会再被“history-only 阈值”二次否决（避免判定触发但不注入）
    - 当前请求若已含 summary node 才跳过；`chat_history` 已含旧 summary 时仍可刷新为新 summary
  - 缓存与兼容
    - `rollingSummary=true` + `cacheTtlMs`：缓存摘要，降低重复 summarization 成本
    - 仅在 `chat_history` 已缺失 summary exchange 时才会走“缓存补回”路径
  - 说明：`runtimeEnabled=true` 时会 patch 上游并禁用客户端 `limitChatHistory` 硬裁剪；旧的按轮数触发/保留字段不再生效

## 鉴权（apiKey / headers）

- `openai_compatible` / `openai_responses`
  - `apiKey` 会自动注入 `Authorization: Bearer <token>`（不要手写 `Bearer ` 前缀）
  - 若使用 `headers.authorization`：请填写完整值（例如 `Bearer ...`），且不要再配置 `apiKey`
- `anthropic`
  - `apiKey` 会自动注入 `x-api-key: <token>`（默认）
  - 若你的代理要求 `Authorization: Bearer`：请在 `headers.authorization` 里显式填写
- `gemini_ai_studio`
  - `apiKey` 会写入 URL query `?key=<token>`（并在 stream 时追加 `alt=sse`）
  - 也可用 `headers` 自定义鉴权（仅当你明确知道上游支持）

## Routing / Model 选择（关键语义）

- BYOK 只对 **13 个 LLM 数据面端点**提供语义实现：见 `docs/ENDPOINTS.md`
  - 其它端点即使设置 `mode=byok`，也会回落 official（因为 runtime shim 只实现了 13 个）
- model id 约定：`byok:<providerId>:<modelId>`
  - `/get-models` 会把 `providers[].models` 注入到 model registry（含 feature flags），从而让上游能选择 `byok:*`
- Model Picker（主面板模型选择）与 Endpoint Rules 的优先级（仅 BYOK 路径生效）
  - **model**：Model Picker 选择的 `byok:*` > `routing.rules[endpoint].model` > `providers[].defaultModel`
  - **providerId**：Model Picker 选择的 `byok:*` > `routing.rules[endpoint].providerId` > `providers[0]`
- Model Picker 列表（`/get-models`）
  - 当 `runtimeEnabled=true` 且 `/get-models` 走 BYOK shim 时，返回的 `models[]` 会只包含 `byok:*`（不再混入官方模型），避免“选了官方模型但 BYOK 实际忽略”的困惑
  - 需要恢复官方模型列表：`BYOK: Disable (Rollback)`（让 `/get-models` 回到官方实现）
- `mode=disabled`
  - `callApi`：返回 `{}`（no-op）
  - `callApiStream`：返回空 stream

## Prompts（多功能提示词）

目的：在不改上游请求结构的前提下，给 BYOK 的上游模型**按 endpoint**追加稳定的“长期规则/偏好”。  
全局规则/偏好请使用 Augment 自带的 `User Guidelines / Workspace Guidelines / Rules`（BYOK 不提供全局追加，避免与 Augment 的全局设置重复/打架）。

- 生效范围：**仅 BYOK**（runtimeEnabled=true 且 endpoint 走 byok 路由时）
- 选择规则：
  - `effectiveSystem = prompts.endpointSystem[endpoint]`（留空即不追加）
  - `endpointSystem` 的 key 会被归一化为 pathname（例如 `"/chat-stream?x=1"` → `"/chat-stream"`）
  - 注：`/get-models` 不会使用 prompt（它只是模型列表；用于注入 model picker），可忽略
- 注入位置（保证输出约束仍在最后）：
  - `/chat` / `/chat-stream`：追加到 chat 的 system prompt（与 `user_guidelines/workspace_guidelines/rules/agent_memories` 同级拼接）
  - 其余 LLM 端点（如 `/edit`、`/completion`…）：追加到“BYOK purpose system prompt”中（输出约束始终最后）

面板操作：
- 一键填充（推荐）：用推荐模板覆盖当前 `endpointSystem`（建议先导出备份；刷新可撤销未保存修改）

建议写法（降低“提示词互相打架”的概率）：
- 写“偏好/约束”，避免写“让模型忽略输出约束”（例如 `/edit` 必须只输出代码）
- 需要按功能差异化：用 `endpointSystem`（例如 commit message 用英文、completion 更保守等）
- 需要“全局偏好”（语言/风格/输出结构等）：用 Augment 的 `User Guidelines`，而不是 BYOK prompts

## 官方上下文注入（仅 `/chat`、`/chat-stream`）

BYOK chat 会尝试调用官方能力，把外部上下文注入到请求中（失败会忽略，不影响 BYOK 生成）：

- `agents/codebase-retrieval`
- `get-implicit-external-sources`
- `search-external-sources`
- `context-canvas/list`

关闭方式：请求体 `disable_retrieval=true` 或 `disableRetrieval=true`

## Provider `requestDefaults` 兼容/兜底

不同 provider 对字段支持不一致；BYOK 会做兼容/过滤，并在 400/422 时做一次兜底重试（尽量把请求“缩到最小可用”）：

- Anthropic
  - 自动过滤 OpenAI-only 字段（如 `presence_penalty`、`response_format`、`stream_options`）
  - 兼容 `stop`→`stop_sequences`、`topP/topK`→`top_p/top_k`
  - 422 `system: invalid type: string`：自动重试 `system=[{type:\"text\",text:\"...\"}]`（兼容部分 Anthropics 代理实现）
  - 若代理进一步要求 `messages[].content` 也必须是 blocks：自动重试 `messages[].content=[{type:\"text\",...}]`
  - 400/422：会最小化 `requestDefaults` 重试（保留 `max_tokens`）
- OpenAI Compatible（Chat Completions）
  - tools → functions → no-tools：按兼容链自动降级（不同网关对 `tools/tool_choice/stream_options` 支持不一致）
  - 并行工具兜底：当请求侧未声明 `support_parallel_tool_use=true` 且存在 tools 时，自动注入 `parallel_tool_calls=false`（并兼容 `parallelToolCalls`）
  - 多模态兜底：不支持 multipart 的网关会自动压平为纯文本（并提示省略非文本部分）
- OpenAI Responses
  - 兼容 `max_tokens/maxTokens/maxOutputTokens` → `max_output_tokens`
  - 并行工具兜底：同上（注入 `parallel_tool_calls=false`；并兼容 `parallelToolCalls`）
  - `status=incomplete` + `incomplete_details.reason`：映射为 Augment `stop_reason`
  - 400/422：最小化 defaults 重试（仅保留 `max_output_tokens`）
- Gemini AI Studio
  - 兼容 `max_tokens/maxTokens/max_output_tokens/maxOutputTokens` → `generationConfig.maxOutputTokens`
  - 400/422：按 `no-defaults/no-images/no-tools` 兜底重试
