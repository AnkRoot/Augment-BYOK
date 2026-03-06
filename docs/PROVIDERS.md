# PROVIDERS（4 个 provider.type 的协议适配）

目标：把 Augment LLM 数据面端点（尤其 `/chat-stream` 的 NDJSON）稳定转换到 4 类上游协议，并在常见网关差异下尽量“可用且可诊断”。

> 术语：
> - “Augment chunk”指 BYOK 输出给 Augment UI 的 NDJSON 行（`{text,nodes,stop_reason,...}`）。
> - 节点/stop_reason 常量见 `payload/extension/out/byok/core/augment-protocol.js`。

## 统一输出（Augment chunk）

- **流式**：每行一个 JSON（`application/x-ndjson` 语义；扩展侧以 async generator 输出）
- **文本增量**：`text` + `nodes[].type=RAW_RESPONSE`（delta 文本）
- **工具调用**：`nodes[].type=TOOL_USE_START`（可选）+ `TOOL_USE`（必有）
  - 由 `feature_detection_flags.support_tool_use_start=true` 决定是否发 START
- **用量**：`nodes[].type=TOKEN_USAGE`（上游支持才发）
- **最终行**：只负责 `stop_reason`（并可选附带少量 nodes）
  - 兼容兜底：若已看到 tool_use，但上游返回 `stop/end_turn`，最终仍会输出 `TOOL_USE_REQUESTED`（避免 UI 不触发工具链）

## 统一输入（Augment request）

BYOK 接受上游 Augment 的多种字段命名，最终会归一到 `normalizeAugmentChatRequest()`（`core/augment-chat/shared/request.js`）。

工具相关：
- `tool_definitions[]` → 按 provider.type 转换为上游 tools 定义（OpenAI / Responses / Anthropic / Gemini 形状不同）
- `request_nodes`/`structured_request_nodes`/`nodes` 中的 `TOOL_RESULT` 会被配对注入到上游（并提供 orphan/missing 兜底）

## Provider 兼容矩阵（关键点）

### 1) `openai_compatible`（Chat Completions）

- **端点**：`POST {baseUrl}/chat/completions`（stream=SSE）
- **鉴权**：`apiKey` → `Authorization: Bearer <token>`（也可用 `headers.authorization` 完整覆盖）
- **工具调用**：支持 `delta.tool_calls[]` + 旧式 `delta.function_call`（arguments 自动聚合）
- **并行工具**：当 `support_parallel_tool_use` 不为 true 且存在 tools 时，自动注入 `parallel_tool_calls=false`（并兼容 `parallelToolCalls`）
- **用量**：优先请求 `stream_options.include_usage=true`；失败会自动降级重试
- **多模态**：不支持 multipart 的网关会自动压平为纯文本（并提示省略）

### 2) `openai_responses`（Responses API）

- **端点**：`POST {baseUrl}/responses`（stream=SSE）
- **鉴权**：同 OpenAI（Bearer）
- **工具调用**：
  - SSE：聚合 `response.output_item.*` + `response.function_call_arguments.*`（兼容缺失 added/done 的变体）
  - JSON：从 `response.output[]` 提取 `function_call`
- **并行工具**：同上（注入 `parallel_tool_calls=false`；并兼容 `parallelToolCalls`）
- **tools schema**：使用 strict JSON schema（补齐 `additionalProperties=false`；对象 schema 的 `required` 强制覆盖全部 `properties`）
- **stop_reason**：解析 `status=incomplete` + `incomplete_details.reason`（`max_output_tokens/content_filter`）映射到 Augment
- **非流式兜底**：部分网关即使 `stream=false` 也只支持 SSE，会自动做一次 stream fallback 拼接文本

### 3) `anthropic`（Messages API）

- **端点**：`POST {baseUrl}/messages`（stream=SSE）
- **鉴权**：`apiKey` → `x-api-key: <token>`（也可用 `headers.authorization` 覆盖）
- **工具调用**：SSE 的 `tool_use + input_json_delta` 会缓冲并在 block stop 时一次性输出 TOOL_USE（可选 START）
- **兼容兜底**：
  - `tool_choice` 失败 → 自动重试无 tool_choice / 无 tools + strip tool blocks
  - 422 `system: invalid type: string` → 自动把 `system/messages[].content` 转 blocks 再重试
  - 不支持 image/tool blocks 的代理 → 自动剥离并注入 placeholder

### 4) `gemini_ai_studio`（Google Generative Language / AI Studio）

- **端点**：
  - 非流式：`.../v1beta/models/<model>:generateContent`
  - 流式：`.../v1beta/models/<model>:streamGenerateContent?alt=sse`
- **鉴权**：`apiKey` 默认写入 query `?key=`（也允许 `headers` 覆盖）
- **文本**：Gemini 常返回“累积全文”，BYOK 用 delta 方式只输出新增部分（避免重复）
- **工具调用**：
  - 输入侧：把 Augment `tool_use_id` 透传为 `functionCall.id / functionResponse.id`
  - 输出侧：优先使用 `parts[].functionCall.id` 作为 Augment `tool_use_id`；避免重复 functionCall 导致重复 TOOL_USE
- **用量/停止原因**：解析 `usageMetadata.*` 与 `finishReason`，并按 Augment stop_reason 映射
- **兼容兜底**：`no-defaults/no-images/no-tools` 逐级降级重试

## 最小可用的 baseUrl 自检

- `openai_compatible`：`/v1` + `POST /chat/completions` 支持 `text/event-stream`
- `openai_responses`：`/v1` + `POST /responses` 支持 `text/event-stream`
- `anthropic`：`/v1` + `POST /messages` 支持 `text/event-stream`
- `gemini_ai_studio`：包含 `/v1beta`（或可拼出 `/v1beta/...`）；stream 支持 `alt=sse`
