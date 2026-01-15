"use strict";

const { normalizeString } = require("../infra/util");
const { RESPONSE_NODE_RAW_RESPONSE, RESPONSE_NODE_MAIN_TEXT_FINISHED, RESPONSE_NODE_TOOL_USE, RESPONSE_NODE_TOOL_USE_START } = require("./augment-protocol");

function asRecord(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function asString(v) {
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

function pick(obj, keys) {
  const o = asRecord(obj);
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(o, k)) return o[k];
  return undefined;
}

function isPlaceholderMessage(message) {
  const s = String(message || "").trim();
  if (!s) return false;
  if (s.length > 16) return false;
  for (const ch of s) if (ch !== "-") return false;
  return true;
}

function mapImageFormatToMimeType(format) {
  const f = Number(format);
  if (f === 2) return "image/jpeg";
  if (f === 3) return "image/gif";
  if (f === 4) return "image/webp";
  return "image/png";
}

function normalizeToolDefinitions(raw) {
  const list = asArray(raw);
  const out = [];
  for (const it of list) {
    const r = asRecord(it);
    const name = normalizeString(pick(r, ["name"]));
    if (!name) continue;
    const description = asString(pick(r, ["description"])) || "";
    const input_schema = pick(r, ["input_schema", "inputSchema"]);
    const input_schema_json = asString(pick(r, ["input_schema_json", "inputSchemaJson"])) || "";
    const mcp_server_name = asString(pick(r, ["mcp_server_name", "mcpServerName"])) || "";
    const mcp_tool_name = asString(pick(r, ["mcp_tool_name", "mcpToolName"])) || "";
    out.push({ name, description, input_schema: input_schema && typeof input_schema === "object" ? input_schema : null, input_schema_json, mcp_server_name, mcp_tool_name });
  }
  return out;
}

function resolveToolSchema(def) {
  if (def && def.input_schema && typeof def.input_schema === "object" && !Array.isArray(def.input_schema)) return def.input_schema;
  const raw = normalizeString(def && def.input_schema_json);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return { type: "object", properties: {} };
}

function convertOpenAiTools(toolDefs) {
  const defs = normalizeToolDefinitions(toolDefs);
  return defs.map((d) => ({ type: "function", function: { name: d.name, ...(normalizeString(d.description) ? { description: d.description } : {}), parameters: resolveToolSchema(d) } }));
}

function convertAnthropicTools(toolDefs) {
  const defs = normalizeToolDefinitions(toolDefs);
  return defs.map((d) => ({ name: d.name, ...(normalizeString(d.description) ? { description: d.description } : {}), input_schema: resolveToolSchema(d) }));
}

function buildToolMetaByName(toolDefs) {
  const defs = normalizeToolDefinitions(toolDefs);
  const map = new Map();
  for (const d of defs) {
    const toolName = normalizeString(d.name);
    if (!toolName) continue;
    const mcpServerName = normalizeString(d.mcp_server_name);
    const mcpToolName = normalizeString(d.mcp_tool_name);
    if (!mcpServerName && !mcpToolName) continue;
    map.set(toolName, { mcpServerName: mcpServerName || undefined, mcpToolName: mcpToolName || undefined });
  }
  return map;
}

function normalizeNodeType(node) {
  const r = asRecord(node);
  const v = pick(r, ["type", "node_type", "nodeType"]);
  const n = Number(v);
  return Number.isFinite(n) ? n : -1;
}

function normalizeChatHistoryItem(raw) {
  const r = asRecord(raw);
  const request_message = asString(pick(r, ["request_message", "requestMessage", "message"]));
  const response_text = asString(pick(r, ["response_text", "responseText", "response", "text"]));
  const request_nodes = asArray(pick(r, ["request_nodes", "requestNodes"]));
  const structured_request_nodes = asArray(pick(r, ["structured_request_nodes", "structuredRequestNodes"]));
  const nodes = asArray(pick(r, ["nodes"]));
  const response_nodes = asArray(pick(r, ["response_nodes", "responseNodes"]));
  const structured_output_nodes = asArray(pick(r, ["structured_output_nodes", "structuredOutputNodes"]));
  return { request_message, response_text, request_nodes, structured_request_nodes, nodes, response_nodes, structured_output_nodes };
}

function normalizeAugmentChatRequest(body) {
  const b = asRecord(body);
  const message = asString(pick(b, ["message", "prompt", "instruction"]));
  const chat_history = asArray(pick(b, ["chat_history", "chatHistory"])).map(normalizeChatHistoryItem);
  const tool_definitions = asArray(pick(b, ["tool_definitions", "toolDefinitions"]));
  const nodes = asArray(pick(b, ["nodes"]));
  const structured_request_nodes = asArray(pick(b, ["structured_request_nodes", "structuredRequestNodes"]));
  const request_nodes = asArray(pick(b, ["request_nodes", "requestNodes"]));
  const agent_memories = asString(pick(b, ["agent_memories", "agentMemories"]));
  const mode = asString(pick(b, ["mode"]));
  const prefix = asString(pick(b, ["prefix"]));
  const suffix = asString(pick(b, ["suffix"]));
  const lang = asString(pick(b, ["lang", "language"]));
  const path = asString(pick(b, ["path"]));
  const user_guidelines = asString(pick(b, ["user_guidelines", "userGuidelines"]));
  const workspace_guidelines = asString(pick(b, ["workspace_guidelines", "workspaceGuidelines"]));
  const rules = pick(b, ["rules"]);
  const feature_detection_flags = asRecord(pick(b, ["feature_detection_flags", "featureDetectionFlags"]));
  return { message, chat_history, tool_definitions, nodes, structured_request_nodes, request_nodes, agent_memories, mode, prefix, suffix, lang, path, user_guidelines, workspace_guidelines, rules, feature_detection_flags };
}

function coerceRulesText(rules) {
  if (Array.isArray(rules)) return rules.map((x) => normalizeString(String(x))).filter(Boolean).join("\n");
  return normalizeString(rules);
}

function buildSystemPrompt(req) {
  const parts = [];
  if (normalizeString(req.prefix)) parts.push(req.prefix.trim());
  if (normalizeString(req.user_guidelines)) parts.push(req.user_guidelines.trim());
  if (normalizeString(req.workspace_guidelines)) parts.push(req.workspace_guidelines.trim());
  const rulesText = coerceRulesText(req.rules);
  if (rulesText) parts.push(rulesText);
  if (normalizeString(req.agent_memories)) parts.push(req.agent_memories.trim());
  if (normalizeString(req.mode).toUpperCase() === "AGENT") parts.push("You are an AI coding assistant with access to tools. Use tools when needed to complete tasks.");
  if (normalizeString(req.lang)) parts.push(`The user is working with ${req.lang.trim()} code.`);
  if (normalizeString(req.path)) parts.push(`Current file path: ${req.path.trim()}`);
  if (normalizeString(req.suffix)) parts.push(`Suffix:\n${req.suffix}`.trim());
  return parts.join("\n\n").trim();
}

function extractAssistantTextFromOutputNodes(nodes) {
  const list = asArray(nodes);
  let finished = "";
  let raw = "";
  for (const n of list) {
    const r = asRecord(n);
    const t = normalizeNodeType(r);
    const content = asString(pick(r, ["content"]));
    if (t === RESPONSE_NODE_MAIN_TEXT_FINISHED && normalizeString(content)) finished = content;
    else if (t === RESPONSE_NODE_RAW_RESPONSE && content) raw += content;
  }
  return normalizeString(finished) ? finished.trim() : raw.trim();
}

function extractToolCallsFromOutputNodes(nodes) {
  const list = asArray(nodes);
  const toolUse = [];
  const toolUseStart = [];
  for (const n of list) {
    const r = asRecord(n);
    const t = normalizeNodeType(r);
    if (t === RESPONSE_NODE_TOOL_USE) toolUse.push(r);
    else if (t === RESPONSE_NODE_TOOL_USE_START) toolUseStart.push(r);
  }
  const chosen = toolUse.length ? toolUse : toolUseStart;
  const seen = new Set();
  const out = [];
  for (const n of chosen) {
    const tu = asRecord(pick(n, ["tool_use", "toolUse"]));
    const toolName = normalizeString(pick(tu, ["tool_name", "toolName"]));
    if (!toolName) continue;
    let id = normalizeString(pick(tu, ["tool_use_id", "toolUseId"]));
    if (!id) id = `tool-${out.length + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const args = normalizeString(pick(tu, ["input_json", "inputJson"])) || "{}";
    out.push({ id, type: "function", function: { name: toolName, arguments: args } });
  }
  return out;
}

function formatNodeValue(label, value) {
  const l = normalizeString(label) || "Node";
  if (value == null) return "";
  try {
    const s = JSON.stringify(value);
    return s && s !== "null" ? `${l}: ${s}` : "";
  } catch {
    return "";
  }
}

function parseJsonObjectOrEmpty(json) {
  const raw = normalizeString(json) || "{}";
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  return {};
}

module.exports = {
  asRecord,
  asArray,
  asString,
  pick,
  isPlaceholderMessage,
  mapImageFormatToMimeType,
  normalizeToolDefinitions,
  resolveToolSchema,
  convertOpenAiTools,
  convertAnthropicTools,
  buildToolMetaByName,
  normalizeNodeType,
  normalizeAugmentChatRequest,
  coerceRulesText,
  buildSystemPrompt,
  extractAssistantTextFromOutputNodes,
  extractToolCallsFromOutputNodes,
  formatNodeValue,
  parseJsonObjectOrEmpty
};
