"use strict";

const crypto = require("crypto");
const { joinBaseUrl, safeFetch, readTextLimit } = require("./http");
const { parseSse } = require("./sse");
const { normalizeString, requireString, normalizeRawToken } = require("../infra/util");
const { withJsonContentType } = require("./headers");
const { normalizeUsageInt, makeToolMetaGetter, assertSseResponse } = require("./provider-util");
const { info } = require("../infra/log");
const { state } = require("../config/state");
const {
  STOP_REASON_END_TURN,
  STOP_REASON_TOOL_USE_REQUESTED,
  mapAnthropicStopReasonToAugment,
  rawResponseNode,
  toolUseStartNode,
  toolUseNode,
  thinkingNode,
  tokenUsageNode,
  mainTextFinishedNode,
  makeBackChatChunk
} = require("../core/augment-protocol");

const CLAUDE_CLI_VERSION = "2.1.12";
const CLAUDE_USER_ID_KEY = "augment-byok.claudeCodeUserId.v1";
// 生成进程级别的 session_id（每次启动生成一次）
const SESSION_ID = crypto.randomBytes(16).toString("hex");
let cachedUserId = "";

function getStableUserId() {
  if (cachedUserId) return cachedUserId;
  const ctx = state && typeof state === "object" ? state.extensionContext : null;
  const stored = ctx?.globalState?.get?.(CLAUDE_USER_ID_KEY);
  if (typeof stored === "string" && stored.trim()) {
    cachedUserId = stored.trim();
    return cachedUserId;
  }
  cachedUserId = crypto.randomBytes(32).toString("hex");
  try {
    ctx?.globalState?.update?.(CLAUDE_USER_ID_KEY, cachedUserId);
  } catch {}
  return cachedUserId;
}

function normalizeAccountUuid(requestDefaults) {
  const md = requestDefaults && typeof requestDefaults === "object" ? requestDefaults.metadata : null;
  const raw = md?.account_uuid ?? md?.accountUuid ?? requestDefaults?.accountUuid ?? requestDefaults?.account_uuid;
  return typeof raw === "string" ? raw.trim() : "";
}

function normalizeToolInputJson(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {}
  }
  return "";
}

function pickMaxTokens(requestDefaults) {
  const v = requestDefaults && typeof requestDefaults === "object" ? requestDefaults.max_tokens ?? requestDefaults.maxTokens : undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 1024;
}

function getClaudeCliUserAgent() {
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || "claude-vscode";
  const agentSdk = process.env.CLAUDE_AGENT_SDK_VERSION ? `, agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}` : "";
  return `claude-cli/${CLAUDE_CLI_VERSION} (external, ${entrypoint}${agentSdk})`;
}

function normalizeBetaList(list) {
  const out = [];
  const push = (v) => {
    if (!v) return;
    const s = String(v).trim();
    if (!s || out.includes(s)) return;
    out.push(s);
  };
  if (Array.isArray(list)) {
    for (const v of list) push(v);
  } else if (typeof list === "string") {
    for (const v of list.split(",").map((x) => x.trim())) push(v);
  }
  return out;
}

function buildClaudeCodeBetas({ model, tools, requestDefaults, extraHeaders }) {
  const betas = [];
  const add = (v) => {
    if (v && !betas.includes(v)) betas.push(v);
  };
  const modelName = typeof model === "string" ? model : "";
  const isHaiku = /haiku/i.test(modelName);

  add("claude-code-20250219");
  if (!isHaiku) add("interleaved-thinking-2025-05-14");
  if (!isHaiku) add("context-1m-2025-08-07");

  const rd = requestDefaults && typeof requestDefaults === "object" ? requestDefaults : null;
  if (rd?.context_management || rd?.contextManagement) add("context-management-2025-06-27");
  if (rd?.output_format || rd?.outputFormat || rd?.response_format || rd?.responseFormat) add("structured-outputs-2025-09-17");

  if (Array.isArray(tools) && tools.length) {
    add("tool-examples-2025-10-29");
    add("advanced-tool-use-2025-11-20");
  }
  if (Array.isArray(tools) && tools.some((t) => t && typeof t.name === "string" && t.name === "MCPSearch")) add("tool-search-tool-2025-10-19");
  if (Array.isArray(tools) && tools.some((t) => t && typeof t.name === "string" && t.name === "WebSearch")) add("web-search-2025-03-05");

  const extra = [];
  extra.push(...normalizeBetaList(rd?.betas ?? rd?.anthropic_beta ?? rd?.anthropicBeta));
  const authHeader = extraHeaders?.authorization ?? extraHeaders?.Authorization;
  if (typeof authHeader === "string" && authHeader.trim().toLowerCase().startsWith("bearer ")) add("oauth-2025-04-20");
  for (const v of extra) add(v);
  return betas;
}

function normalizeCliHeaderMode(requestDefaults) {
  const raw = requestDefaults?.cliHeadersMode ?? requestDefaults?.cli_headers_mode;
  const mode = normalizeString(raw);
  return mode === "minimal" ? "minimal" : "strict";
}

function claudeCodeHeaders(key, extraHeaders, betas, dangerouslyAllowBrowser, headerMode) {
  const baseHeaders = {
    "anthropic-beta": Array.isArray(betas) && betas.length ? betas.join(",") : "claude-code-20250219"
  };
  const cliHeaders = headerMode === "strict" ? {
    "x-app": "cli",
    "user-agent": getClaudeCliUserAgent(),
    "x-stainless-arch": process.arch || "arm64",
    "x-stainless-helper-method": "stream",
    "x-stainless-lang": "js",
    "x-stainless-os": process.platform === "darwin" ? "MacOS" : process.platform === "win32" ? "Windows" : "Linux",
    "x-stainless-package-version": "0.70.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version.replace(/^v/, ""),
    "x-stainless-timeout": "600",
    "connection": "keep-alive",
    "accept-encoding": "gzip, deflate, br, zstd"
  } : {};
  if (dangerouslyAllowBrowser) cliHeaders["anthropic-dangerous-direct-browser-access"] = "true";
  const extra = extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {};
  return { ...baseHeaders, ...cliHeaders, ...(key ? { "x-api-key": key } : {}), ...extra, "anthropic-version": "2023-06-01" };
}

function buildClaudeCodeRequest({ baseUrl, apiKey, model, system, messages, tools, extraHeaders, requestDefaults, stream }) {
  const url = joinBaseUrl(requireString(baseUrl, "Anthropic baseUrl"), "messages") + "?beta=true";
  const key = normalizeRawToken(apiKey);
  const extra = extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {};
  if (!key && Object.keys(extra).length === 0) throw new Error("Anthropic apiKey 未配置（且 headers 为空）");
  const m = requireString(model, "Anthropic model");
  if (!Array.isArray(messages) || !messages.length) throw new Error("Anthropic messages 为空");

  // 构建 system prompt（参考实现格式）
  const cliSystem = [
    {
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
      cache_control: { type: "ephemeral" }
    }
  ];
  if (system) {
    if (typeof system === "string" && system.trim()) {
      cliSystem.push({ type: "text", text: system.trim() });
    } else if (Array.isArray(system)) {
      cliSystem.push(...system);
    }
  }

  // 按照 CLI 的字段顺序构建 body
  const body = {};
  body.model = m;
  body.messages = messages;
  body.system = cliSystem;

  // tools（总是包含，即使为空）
  const toolsArray = Array.isArray(tools) && tools.length ? tools : [];
  body.tools = toolsArray;

  // metadata
  const metadata = requestDefaults && typeof requestDefaults === "object" && requestDefaults.metadata && typeof requestDefaults.metadata === "object"
    ? { ...requestDefaults.metadata }
    : {};
  if (!metadata.user_id) {
    const accountUuid = normalizeAccountUuid(requestDefaults);
    const userId = getStableUserId();
    metadata.user_id = `user_${userId}_account_${accountUuid}_session_${SESSION_ID}`;
  }
  body.metadata = metadata;

  // max_tokens
  body.max_tokens = pickMaxTokens(requestDefaults);

  // stream
  body.stream = Boolean(stream);

  // 合并 requestDefaults（但不覆盖已有字段）
  if (requestDefaults && typeof requestDefaults === "object") {
    for (const k in requestDefaults) {
      if (k !== "max_tokens" && k !== "maxTokens" && !body.hasOwnProperty(k)) {
        body[k] = requestDefaults[k];
      }
    }
  }

  // tool_choice（如果有 tools）
  if (toolsArray.length > 0) {
    body.tool_choice = { type: "auto" };
  }

  const betas = buildClaudeCodeBetas({ model: m, tools: toolsArray, requestDefaults, extraHeaders });
  const dangerouslyAllowBrowser = Boolean(requestDefaults?.dangerouslyAllowBrowser ?? requestDefaults?.dangerously_allow_browser ?? requestDefaults?.dangerous_direct_browser_access);
  const headerMode = normalizeCliHeaderMode(requestDefaults);
  const headers = withJsonContentType(claudeCodeHeaders(key, extraHeaders, betas, dangerouslyAllowBrowser, headerMode));
  if (stream) headers.accept = "text/event-stream";
  return { url, headers, body };
}

async function anthropicClaudeCodeCompleteText({ baseUrl, apiKey, model, system, messages, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const { url, headers, body } = buildClaudeCodeRequest({ baseUrl, apiKey, model, system, messages, tools: [], extraHeaders, requestDefaults, stream: false });

  const resp = await safeFetch(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: "Anthropic(ClaudeCode)" });

  if (!resp.ok) throw new Error(`Anthropic(ClaudeCode) ${resp.status}: ${await readTextLimit(resp, 500)}`.trim());
  const json = await resp.json().catch(() => null);
  const blocks = Array.isArray(json?.content) ? json.content : [];
  const text = blocks.map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
  if (text.trim()) return text;
  throw new Error("Anthropic(ClaudeCode) 响应缺少 content[].text");
}

async function* anthropicClaudeCodeStreamTextDeltas({ baseUrl, apiKey, model, system, messages, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const { url, headers, body } = buildClaudeCodeRequest({ baseUrl, apiKey, model, system, messages, tools: [], extraHeaders, requestDefaults, stream: true });

  const resp = await safeFetch(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: "Anthropic(ClaudeCode-stream)" });

  if (!resp.ok) throw new Error(`Anthropic(ClaudeCode-stream) ${resp.status}: ${await readTextLimit(resp, 500)}`.trim());
  await assertSseResponse(resp, { label: "Anthropic(ClaudeCode-stream)" });
  let emitted = 0;
  for await (const ev of parseSse(resp)) {
    const data = normalizeString(ev?.data);
    if (!data) continue;
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    if (json?.type === "message_stop") break;
    if (json?.type === "content_block_delta" && json.delta?.type === "text_delta" && typeof json.delta.text === "string") {
      const t = json.delta.text;
      if (t) { emitted += 1; yield t; }
    }
  }
  if (emitted === 0) throw new Error("Anthropic(ClaudeCode-stream) 未解析到任何 SSE delta");
}

async function* anthropicClaudeCodeChatStreamChunks({ baseUrl, apiKey, model, system, messages, tools, timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart }) {
  const { url, headers, body } = buildClaudeCodeRequest({ baseUrl, apiKey, model, system, messages, tools, extraHeaders, requestDefaults, stream: true });
  const resp = await safeFetch(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: "Anthropic(ClaudeCode-chat)" });
  if (!resp.ok) throw new Error(`Anthropic(ClaudeCode-chat) ${resp.status}: ${await readTextLimit(resp, 500)}`.trim());
  await assertSseResponse(resp, { label: "Anthropic(ClaudeCode-chat)" });

  const getToolMeta = makeToolMetaGetter(toolMetaByName);
  let nodeId = 0;
  let fullText = "";
  let stopReason = null;
  let stopReasonSeen = false;
  let sawToolUse = false;
  let usageInputTokens = null;
  let usageOutputTokens = null;
  let usageCacheReadInputTokens = null;
  let usageCacheCreationInputTokens = null;
  let currentBlockType = "";
  let thinkingBuf = "";
  let toolBlocks = {};
  let dataEvents = 0;
  let parsedChunks = 0;
  let emittedChunks = 0;

  for await (const ev of parseSse(resp)) {
    const data = normalizeString(ev?.data);
    if (!data) continue;
    dataEvents += 1;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    parsedChunks += 1;
    const eventType = normalizeString(json?.type) || normalizeString(ev?.event);

    const usage = (json?.message && typeof json.message === "object" ? json.message.usage : null) || json?.usage;
    if (usage && typeof usage === "object") {
      const it = normalizeUsageInt(usage.input_tokens);
      const ot = normalizeUsageInt(usage.output_tokens);
      const cr = normalizeUsageInt(usage.cache_read_input_tokens);
      const cc = normalizeUsageInt(usage.cache_creation_input_tokens);
      if (it != null) usageInputTokens = it;
      if (ot != null) usageOutputTokens = ot;
      if (cr != null) usageCacheReadInputTokens = cr;
      if (cc != null) usageCacheCreationInputTokens = cc;
    }

    if (eventType === "content_block_start") {
      const block = json?.content_block && typeof json.content_block === "object" ? json.content_block : null;
      const index = typeof json?.index === "number" ? json.index : -1;
      currentBlockType = normalizeString(block?.type);
      if ((currentBlockType === "tool_use" || currentBlockType === "server_tool_use" || currentBlockType === "mcp_tool_use") && index >= 0) {
        toolBlocks[index] = {
          id: normalizeString(block?.id ?? block?.tool_use_id ?? block?.toolUseId),
          name: normalizeString(block?.name ?? block?.tool_name ?? block?.toolName),
          input_json: ""
        };
      } else if (currentBlockType === "thinking") {
        thinkingBuf = "";
      }
      continue;
    }

    if (eventType === "content_block_delta") {
      const delta = json?.delta && typeof json.delta === "object" ? json.delta : null;
      const deltaIndex = typeof json?.index === "number" ? json.index : -1;
      const dt = normalizeString(delta?.type);
      if (dt === "text_delta" && typeof delta?.text === "string" && delta.text) {
        const t = delta.text;
        fullText += t;
        nodeId += 1;
        emittedChunks += 1;
        yield makeBackChatChunk({ text: t, nodes: [rawResponseNode({ id: nodeId, content: t })] });
      } else if (dt === "input_json_delta" && typeof delta?.partial_json === "string" && delta.partial_json) {
        if (toolBlocks[deltaIndex]) toolBlocks[deltaIndex].input_json += delta.partial_json;
      } else if (dt === "thinking_delta" && typeof delta?.thinking === "string" && delta.thinking) {
        thinkingBuf += delta.thinking;
      }
      continue;
    }

    if (eventType === "content_block_stop") {
      if (currentBlockType === "thinking") {
        const summary = normalizeString(thinkingBuf);
        if (summary) {
          nodeId += 1;
          emittedChunks += 1;
          yield makeBackChatChunk({ text: "", nodes: [thinkingNode({ id: nodeId, summary })] });
        }
        thinkingBuf = "";
      } else if (currentBlockType === "tool_use" || currentBlockType === "server_tool_use" || currentBlockType === "mcp_tool_use") {
        const index = typeof json?.index === "number" ? json.index : -1;
        const block = index >= 0 ? toolBlocks[index] : null;
        if (block) {
          const name = normalizeString(block.name);
          if (name) {
            let id = normalizeString(block.id);
            if (!id) id = `tool-${nodeId + 1}`;
            const inputJson = normalizeString(block.input_json) || "{}";
            const meta = getToolMeta(name);
            sawToolUse = true;
            if (supportToolUseStart === true) {
              nodeId += 1;
              emittedChunks += 1;
              yield makeBackChatChunk({ text: "", nodes: [toolUseStartNode({ id: nodeId, toolUseId: id, toolName: name, inputJson, mcpServerName: meta.mcpServerName, mcpToolName: meta.mcpToolName })] });
            }
            nodeId += 1;
            emittedChunks += 1;
            yield makeBackChatChunk({ text: "", nodes: [toolUseNode({ id: nodeId, toolUseId: id, toolName: name, inputJson, mcpServerName: meta.mcpServerName, mcpToolName: meta.mcpToolName })] });
          }
          delete toolBlocks[index];
        }
      }
      currentBlockType = "";
      continue;
    }

    if (eventType === "message_delta") {
      const delta = json?.delta && typeof json.delta === "object" ? json.delta : null;
      const sr = normalizeString(delta?.stop_reason);
      if (sr) {
        stopReasonSeen = true;
        stopReason = mapAnthropicStopReasonToAugment(sr);
        if (sr === "tool_use" || sr === "server_tool_use" || sr === "mcp_tool_use") {
          const sortedIndexes = Object.keys(toolBlocks).map(Number).sort((a, b) => a - b);
          for (const index of sortedIndexes) {
            const block = toolBlocks[index];
            const name = normalizeString(block.name);
            if (name) {
              let id = normalizeString(block.id);
              if (!id) id = `tool-${nodeId + 1}`;
              const inputJson = normalizeString(block.input_json) || "{}";
              const meta = getToolMeta(name);
              sawToolUse = true;
              if (supportToolUseStart === true) {
                nodeId += 1;
                emittedChunks += 1;
                yield makeBackChatChunk({ text: "", nodes: [toolUseStartNode({ id: nodeId, toolUseId: id, toolName: name, inputJson, mcpServerName: meta.mcpServerName, mcpToolName: meta.mcpToolName })] });
              }
              nodeId += 1;
              emittedChunks += 1;
              yield makeBackChatChunk({ text: "", nodes: [toolUseNode({ id: nodeId, toolUseId: id, toolName: name, inputJson, mcpServerName: meta.mcpServerName, mcpToolName: meta.mcpToolName })] });
            }
          }
          toolBlocks = {};
        }
      }
      continue;
    }

    if (eventType === "message_stop") break;
    if (eventType === "error") {
      const msg = normalizeString(json?.error?.message) || normalizeString(json?.message) || "upstream error event";
      yield makeBackChatChunk({ text: `❌ 上游返回 error event: ${msg}`.trim(), stop_reason: STOP_REASON_END_TURN });
      return;
    }
  }

  if (currentBlockType === "thinking") {
    const summary = normalizeString(thinkingBuf);
    if (summary) {
      nodeId += 1;
      emittedChunks += 1;
      yield makeBackChatChunk({ text: "", nodes: [thinkingNode({ id: nodeId, summary })] });
    }
  }

  const sortedIndexes = Object.keys(toolBlocks).map(Number).sort((a, b) => a - b);
  if (sortedIndexes.length > 0) {
    for (const index of sortedIndexes) {
      const block = toolBlocks[index];
      const name = normalizeString(block.name);
      if (name) {
        let id = normalizeString(block.id);
        if (!id) id = `tool-${nodeId + 1}`;
        const inputJson = normalizeString(block.input_json) || "{}";
        const meta = getToolMeta(name);
        sawToolUse = true;
        if (supportToolUseStart === true) {
          nodeId += 1;
          emittedChunks += 1;
          yield makeBackChatChunk({ text: "", nodes: [toolUseStartNode({ id: nodeId, toolUseId: id, toolName: name, inputJson, mcpServerName: meta.mcpServerName, mcpToolName: meta.mcpToolName })] });
        }
        nodeId += 1;
        emittedChunks += 1;
        yield makeBackChatChunk({ text: "", nodes: [toolUseNode({ id: nodeId, toolUseId: id, toolName: name, inputJson, mcpServerName: meta.mcpServerName, mcpToolName: meta.mcpToolName })] });
      }
    }
  }

  const hasUsage = usageInputTokens != null || usageOutputTokens != null || usageCacheReadInputTokens != null || usageCacheCreationInputTokens != null;
  if (emittedChunks === 0 && !hasUsage && !sawToolUse) {
    throw new Error(`Anthropic(ClaudeCode-chat) 未解析到任何上游 SSE 内容（data_events=${dataEvents}, parsed_chunks=${parsedChunks}）；请检查 baseUrl 是否为 Anthropic /messages SSE`);
  }

  if (hasUsage) {
    nodeId += 1;
    yield makeBackChatChunk({ text: "", nodes: [tokenUsageNode({ id: nodeId, inputTokens: usageInputTokens, outputTokens: usageOutputTokens, cacheReadInputTokens: usageCacheReadInputTokens, cacheCreationInputTokens: usageCacheCreationInputTokens })] });
  }

  const finalNodes = [];
  if (fullText) {
    nodeId += 1;
    finalNodes.push(mainTextFinishedNode({ id: nodeId, content: fullText }));
  }

  const stop_reason = stopReasonSeen && stopReason != null ? stopReason : sawToolUse ? STOP_REASON_TOOL_USE_REQUESTED : STOP_REASON_END_TURN;
  yield makeBackChatChunk({ text: "", nodes: finalNodes, stop_reason });
}

module.exports = { anthropicClaudeCodeCompleteText, anthropicClaudeCodeStreamTextDeltas, anthropicClaudeCodeChatStreamChunks };
