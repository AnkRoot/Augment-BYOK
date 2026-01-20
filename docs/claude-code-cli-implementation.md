# Claude Code CLI vs 标准 Anthropic API 实现差异

## 概述

本文档描述了 `anthropic_claude_code` provider 与标准 `anthropic` provider 的关键差异。

## 1. 请求 Headers 差异

### 标准 Anthropic API
```javascript
{
  "anthropic-version": "2023-06-01",
  "x-api-key": "your-api-key",
  "content-type": "application/json"
}
```

### Claude Code CLI
```javascript
{
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,context-1m-2025-08-07,context-management-2025-06-27,structured-outputs-2025-09-17,tool-examples-2025-10-29,advanced-tool-use-2025-11-20,tool-search-tool-2025-10-19,web-search-2025-03-05",
  "anthropic-dangerous-direct-browser-access": "true", // 可选，仅在启用相关模式时
  "x-api-key": "your-api-key",
  "x-app": "cli",
  "user-agent": "claude-cli/2.1.12 (external, claude-vscode)",
  "x-stainless-arch": "arm64",
  "x-stainless-helper-method": "stream",
  "x-stainless-lang": "js",
  "x-stainless-os": "MacOS",
  "x-stainless-package-version": "0.70.0",
  "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "20.0.0",
  "x-stainless-timeout": "600",
  "connection": "keep-alive",
  "accept-encoding": "gzip, deflate, br, zstd",
  "content-type": "application/json"
}
```

**关键差异：**
- CLI 包含 `anthropic-beta` 头，且为**动态拼接**（基础 + 模型/功能附加）
- CLI **可能**包含 `anthropic-dangerous-direct-browser-access` 头（仅在启用相关模式时）
- CLI 包含多个 `x-stainless-*` 头（由 SDK 注入，版本/运行时可能变化）
- CLI 包含 `x-app: cli` 标识
- CLI 的 `x-stainless-runtime-version` 移除了 'v' 前缀（如 `20.0.0` 而非 `v20.0.0`）
- CLI 包含 `connection: keep-alive` 和 `accept-encoding: gzip, deflate, br, zstd`

### Header 模拟模式（本项目）
- `requestDefaults.cliHeadersMode = "strict" | "minimal"`
- 默认是 `"strict"`（即使本地项目未配置）
- `"strict"`：发送 CLI + SDK 相关头（`x-app`/`x-stainless-*`/`user-agent` 等）
- `"minimal"`：只发送必要头（`anthropic-version`/`anthropic-beta`/鉴权/`content-type`/`accept`）

## 2. URL 差异

### 标准 Anthropic API
```
https://api.anthropic.com/v1/messages
```

### Claude Code CLI
```
https://api.anthropic.com/v1/messages?beta=true
```

**关键差异：**
- CLI 在 URL 中添加 `?beta=true` 查询参数

## 3. System Prompt 差异

### 标准 Anthropic API
```javascript
// 字符串格式
system: "Your custom system prompt"

// 或不设置
```

### Claude Code CLI
```javascript
// 数组格式，强制包含 CLI 身份
system: [
  {
    type: "text",
    text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
    cache_control: { type: "ephemeral" }
  },
  {
    type: "text",
    text: "Your custom system prompt"
  }
]
```

**关键差异：**
- CLI 强制使用数组格式
- CLI 强制在开头添加 "You are Claude Code..." 身份声明，并包含 "running within the Claude Agent SDK"
- CLI 的第一个 system block 包含 `cache_control: { type: "ephemeral" }`
- 用户的 system prompt 会追加在 CLI 身份声明之后（不带换行符前缀）

## 4. Metadata 差异

### 标准 Anthropic API
```javascript
// 通常不包含 metadata
// 或包含简单的 metadata
metadata: {
  user_id: "user-123"
}
```

### Claude Code CLI
```javascript
metadata: {
  user_id: "user_<stable_random_id>_account_<account_uuid>_session_<session_id>"
}
```

**关键差异：**
- CLI 自动生成 `user_id`
- `user_id` 格式：`user_` + **本地持久化随机 ID** + `_account_` + **OAuth account UUID（可为空）** + `_session_` + **进程级 session_id**
- 稳定用户 ID 在本地持久化，跨会话保持
- session_id 使用随机字符串（进程级）

## 5. Tools 字段差异

### 标准 Anthropic API
```javascript
// 只在有 tools 时才包含
if (tools && tools.length > 0) {
  body.tools = tools;
  body.tool_choice = { type: "auto" };
}
```

### Claude Code CLI
```javascript
// 总是包含 tools 字段，即使为空
body.tools = Array.isArray(tools) && tools.length ? tools : [];

// 只在有 tools 时才包含 tool_choice
if (body.tools.length) {
  body.tool_choice = { type: "auto" };
}
```

**关键差异：**
- CLI 总是包含 `tools` 字段，即使是空数组 `[]`
- 标准 API 只在有 tools 时才包含 `tools` 字段

## 6. 请求体字段顺序

### 标准 Anthropic API
```javascript
{
  model,
  max_tokens,
  messages,
  system,      // 可选
  tools,       // 可选
  tool_choice, // 可选
  stream
}
```

### Claude Code CLI
```javascript
{
  model,
  messages,
  system,
  tools,
  metadata,
  max_tokens,
  stream,
  tool_choice // 如果有 tools
}
```

**关键差异：**
- CLI 有特定的字段顺序要求：`model → messages → system → tools → metadata → max_tokens → stream → tool_choice`
- CLI 将 `metadata` 放在 `max_tokens` 之前
- CLI 将 `tool_choice` 放在最后（如果存在）
- CLI 总是包含 `tools` 字段（即使为空）

## 7. SSE 响应差异

### Claude Code CLI
- `content_block` 可能返回 `tool_use` / `server_tool_use` / `mcp_tool_use`
- `message_delta.stop_reason` 可能返回 `tool_use` / `server_tool_use` / `mcp_tool_use`
- `input_json_delta` 使用 `partial_json` 片段，需要拼接成完整 JSON 作为 tool input

**关键差异：**
- CLI 的工具调用可能使用 `server_tool_use` / `mcp_tool_use`，需要与 `tool_use` 同等处理

## 8. 实现代码位置

### 标准 Anthropic API
- 文件：`payload/extension/out/byok/providers/anthropic.js`
- 函数：`anthropicCompleteText`, `anthropicStreamTextDeltas`, `anthropicChatStreamChunks`

### Claude Code CLI
- 文件：`payload/extension/out/byok/providers/anthropic-claude-code.js`
- 函数：`anthropicClaudeCodeCompleteText`, `anthropicClaudeCodeStreamTextDeltas`, `anthropicClaudeCodeChatStreamChunks`

## 9. 配置示例

### config.json 配置
```json
{
  "id": "anthropic-cli",
  "type": "anthropic_claude_code",
  "baseUrl": "https://api.anthropic.com/v1",
  "apiKey": "sk-ant-your-api-key",
  "models": ["claude-sonnet-4-5-20250929"],
  "defaultModel": "claude-sonnet-4-5-20250929",
  "headers": {},
  "requestDefaults": { "max_tokens": 8192, "cliHeadersMode": "strict" }
}
```

## 10. 使用场景

### 何时使用标准 Anthropic API
- 标准的 Claude API 调用
- 不需要 Claude Code 特定功能
- 与其他 Anthropic API 客户端兼容

### 何时使用 Claude Code CLI
- 需要模拟官方 Claude Code CLI 的行为
- 需要通过代理服务器（如本地测试服务器）
- 需要 Claude Code 特定的 beta 功能（如 `interleaved-thinking`）
- 需要与官方 CLI 完全一致的请求格式

## 10. 注意事项

1. **稳定 ID**：CLI 使用本地持久化随机 ID 生成 `user_id`，跨会话保持稳定
2. **Session ID**：进程级随机十六进制字符串确保同一进程内的所有请求使用相同的 session ID
3. **Beta 功能**：CLI 会动态追加 `anthropic-beta` 列表（基础 + 功能/模型相关）
4. **字段顺序**：某些代理服务器可能对字段顺序敏感，CLI 实现确保正确的顺序
5. **Tools 字段**：CLI 总是包含 `tools` 字段（即使为空）
6. **Cache Control**：System prompt 的第一个 block 包含 `cache_control: { type: "ephemeral" }` 以优化缓存
7. **危险头**：`anthropic-dangerous-direct-browser-access` 仅在显式启用相关模式时才会出现
