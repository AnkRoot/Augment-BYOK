"use strict";

const REQUEST_NODE_TEXT = 0;
const REQUEST_NODE_TOOL_RESULT = 1;
const REQUEST_NODE_IMAGE = 2;
const REQUEST_NODE_IMAGE_ID = 3;
const REQUEST_NODE_IDE_STATE = 4;
const REQUEST_NODE_EDIT_EVENTS = 5;
const REQUEST_NODE_CHECKPOINT_REF = 6;
const REQUEST_NODE_CHANGE_PERSONALITY = 7;
const REQUEST_NODE_FILE = 8;
const REQUEST_NODE_FILE_ID = 9;
const REQUEST_NODE_HISTORY_SUMMARY = 10;

const RESPONSE_NODE_RAW_RESPONSE = 0;
const RESPONSE_NODE_SUGGESTED_QUESTIONS = 1;
const RESPONSE_NODE_MAIN_TEXT_FINISHED = 2;
const RESPONSE_NODE_TOOL_USE = 5;
const RESPONSE_NODE_AGENT_MEMORY = 6;
const RESPONSE_NODE_TOOL_USE_START = 7;
const RESPONSE_NODE_THINKING = 8;
const RESPONSE_NODE_BILLING_METADATA = 9;
const RESPONSE_NODE_TOKEN_USAGE = 10;

const STOP_REASON_UNSPECIFIED = 0;
const STOP_REASON_END_TURN = 1;
const STOP_REASON_MAX_TOKENS = 2;
const STOP_REASON_TOOL_USE_REQUESTED = 3;
const STOP_REASON_SAFETY = 4;
const STOP_REASON_RECITATION = 5;
const STOP_REASON_MALFORMED_FUNCTION_CALL = 6;

function mapAnthropicStopReasonToAugment(reason) {
  const r = typeof reason === "string" ? reason.trim().toLowerCase() : "";
  if (r === "end_turn") return STOP_REASON_END_TURN;
  if (r === "max_tokens") return STOP_REASON_MAX_TOKENS;
  if (r === "tool_use") return STOP_REASON_TOOL_USE_REQUESTED;
  if (r === "stop_sequence") return STOP_REASON_END_TURN;
  if (r === "safety") return STOP_REASON_SAFETY;
  if (r === "recitation") return STOP_REASON_RECITATION;
  return STOP_REASON_END_TURN;
}

function mapOpenAiFinishReasonToAugment(reason) {
  const r = typeof reason === "string" ? reason.trim().toLowerCase() : "";
  if (r === "stop") return STOP_REASON_END_TURN;
  if (r === "length") return STOP_REASON_MAX_TOKENS;
  if (r === "tool_calls") return STOP_REASON_TOOL_USE_REQUESTED;
  if (r === "function_call") return STOP_REASON_TOOL_USE_REQUESTED;
  if (r === "content_filter") return STOP_REASON_SAFETY;
  return STOP_REASON_END_TURN;
}

function makeToolUse({ toolUseId, toolName, inputJson, mcpServerName, mcpToolName }) {
  const out = { tool_use_id: String(toolUseId || ""), tool_name: String(toolName || ""), input_json: String(inputJson || "") };
  const msn = typeof mcpServerName === "string" ? mcpServerName.trim() : "";
  const mtn = typeof mcpToolName === "string" ? mcpToolName.trim() : "";
  if (msn) out.mcp_server_name = msn;
  if (mtn) out.mcp_tool_name = mtn;
  return out;
}

function rawResponseNode({ id, content }) {
  return { id: Number(id) || 0, type: RESPONSE_NODE_RAW_RESPONSE, content: String(content || "") };
}

function mainTextFinishedNode({ id, content }) {
  return { id: Number(id) || 0, type: RESPONSE_NODE_MAIN_TEXT_FINISHED, content: String(content || "") };
}

function toolUseStartNode({ id, toolUseId, toolName, inputJson, mcpServerName, mcpToolName }) {
  return { id: Number(id) || 0, type: RESPONSE_NODE_TOOL_USE_START, content: "", tool_use: makeToolUse({ toolUseId, toolName, inputJson, mcpServerName, mcpToolName }) };
}

function toolUseNode({ id, toolUseId, toolName, inputJson, mcpServerName, mcpToolName }) {
  return { id: Number(id) || 0, type: RESPONSE_NODE_TOOL_USE, content: "", tool_use: makeToolUse({ toolUseId, toolName, inputJson, mcpServerName, mcpToolName }) };
}

function thinkingNode({ id, summary }) {
  return { id: Number(id) || 0, type: RESPONSE_NODE_THINKING, content: "", thinking: { summary: String(summary || "") } };
}

function tokenUsageNode({ id, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens }) {
  const tu = {};
  if (Number.isFinite(Number(inputTokens))) tu.input_tokens = Number(inputTokens);
  if (Number.isFinite(Number(outputTokens))) tu.output_tokens = Number(outputTokens);
  if (Number.isFinite(Number(cacheReadInputTokens))) tu.cache_read_input_tokens = Number(cacheReadInputTokens);
  if (Number.isFinite(Number(cacheCreationInputTokens))) tu.cache_creation_input_tokens = Number(cacheCreationInputTokens);
  return { id: Number(id) || 0, type: RESPONSE_NODE_TOKEN_USAGE, content: "", token_usage: tu };
}

function makeBackChatChunk({ text, nodes, stop_reason, includeNodes } = {}) {
  const out = { text: typeof text === "string" ? text : String(text ?? ""), unknown_blob_names: [], checkpoint_not_found: false, workspace_file_chunks: [] };
  const ns = Array.isArray(nodes) ? nodes : [];
  if (includeNodes || ns.length) out.nodes = ns;
  if (stop_reason != null) out.stop_reason = stop_reason;
  return out;
}

module.exports = {
  REQUEST_NODE_TEXT,
  REQUEST_NODE_TOOL_RESULT,
  REQUEST_NODE_IMAGE,
  REQUEST_NODE_IMAGE_ID,
  REQUEST_NODE_IDE_STATE,
  REQUEST_NODE_EDIT_EVENTS,
  REQUEST_NODE_CHECKPOINT_REF,
  REQUEST_NODE_CHANGE_PERSONALITY,
  REQUEST_NODE_FILE,
  REQUEST_NODE_FILE_ID,
  REQUEST_NODE_HISTORY_SUMMARY,
  RESPONSE_NODE_RAW_RESPONSE,
  RESPONSE_NODE_SUGGESTED_QUESTIONS,
  RESPONSE_NODE_MAIN_TEXT_FINISHED,
  RESPONSE_NODE_TOOL_USE,
  RESPONSE_NODE_AGENT_MEMORY,
  RESPONSE_NODE_TOOL_USE_START,
  RESPONSE_NODE_THINKING,
  RESPONSE_NODE_BILLING_METADATA,
  RESPONSE_NODE_TOKEN_USAGE,
  STOP_REASON_UNSPECIFIED,
  STOP_REASON_END_TURN,
  STOP_REASON_MAX_TOKENS,
  STOP_REASON_TOOL_USE_REQUESTED,
  STOP_REASON_SAFETY,
  STOP_REASON_RECITATION,
  STOP_REASON_MALFORMED_FUNCTION_CALL,
  mapAnthropicStopReasonToAugment,
  mapOpenAiFinishReasonToAugment,
  rawResponseNode,
  mainTextFinishedNode,
  toolUseStartNode,
  toolUseNode,
  thinkingNode,
  tokenUsageNode,
  makeBackChatChunk
};

