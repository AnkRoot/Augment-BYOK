# CONFIG

单一真相：`globalState` 里的 `augment-byok.config.v1`（配置面板手填；无 JSON Import/Export）。

## 存储 keys

- `augment-byok.config.v1`：配置（含 Key/Token；不参与 Sync）
- `augment-byok.runtimeEnabled.v1`：运行时回滚开关（唯一加入 Sync）
- `augment-byok.historySummaryCache.v1`：历史摘要缓存（不参与 Sync）

## 命令

- `BYOK: Open Config Panel`：手动填写 + `Save` 生效
- `BYOK: Reload Config`：重新加载（丢弃未保存修改）
- `BYOK: Enable` / `BYOK: Disable (Rollback)`：运行时开关（不改配置）
- `BYOK: Clear History Summary Cache`：清理后台摘要缓存

## 配置结构（v1，概要）

- `official`：`completionUrl` / `apiToken`（用于 `/get-models` 合并 + 官方上下文注入）
- `providers[]`：上游列表
  - `id`：provider 标识（`byok:<providerId>:...`）
  - `type`：`openai_compatible` | `openai_responses` | `anthropic` | `gemini_ai_studio`
  - `baseUrl`、`apiKey`（可空，若 `headers` 已含鉴权）、`headers`、`models`、`defaultModel`、`requestDefaults`
- `routing`：`rules[endpoint]`（`mode=official|byok|disabled`；provider 留空时默认使用 `providers[0]`）
- `historySummary`：面板只暴露 `enabled` + `model`；其它字段默认/保留
- `telemetry.disabledEndpoints`：legacy（会迁移到 `routing.rules[*].mode=disabled`）

## 语义/限制

- BYOK 只对 **13 个 LLM 数据面端点**提供语义实现：见 `ENDPOINTS.md`（其它端点即使配置 `byok` 也会回落 official）
- model id：`byok:<providerId>:<modelId>`（`/get-models` 会注入 model registry/feature flags）
- `/chat` 仅支持 `openai_compatible` / `anthropic`；`/chat-stream` 支持全部 `providers[].type`
- `mode=disabled`：`callApi` 返回 `{}`；`callApiStream` 返回空 stream
- 官方上下文注入（仅 `/chat`、`/chat-stream`）：`agents/codebase-retrieval`、`get-implicit-external-sources`、`search-external-sources`、`context-canvas/list`
  - 关闭：请求体 `disable_retrieval=true` 或 `disableRetrieval=true`
  - 失败：忽略（不影响 BYOK 生成）
- 工具调用：会做 tool_result 配对修复避免 400/422（实现见 `payload/extension/out/byok/core/tool-pairing.js`）
- Anthropic：`requestDefaults` 会自动过滤 OpenAI-only 字段（如 `presence_penalty`、`response_format`、`stream_options`），并兼容 `stop`→`stop_sequences`、`topP/topK`→`top_p/top_k`
- Anthropic：遇到 400/422 会自动做一次“最小化 requestDefaults”重试（保留 `max_tokens`），降低偶发 INVALID_ARGUMENT
