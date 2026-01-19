"use strict";

const { normalizeString } = require("../infra/util");
const shared = require("./augment-chat.shared");
const { getChatHistoryAndRequestNodesForAPI } = require("./augment-history-summary");
const {
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
  TOOL_RESULT_CONTENT_TEXT,
  TOOL_RESULT_CONTENT_IMAGE,
  RESPONSE_NODE_TOOL_USE,
  RESPONSE_NODE_TOOL_USE_START
} = require("./augment-protocol");

function buildAnthropicToolResultContent(fallbackText, contentNodes) {
  const nodes = shared.asArray(contentNodes);
  const out = [];
  let lastText = "";
  for (const n of nodes) {
    const r = shared.asRecord(n);
    const t = Number(shared.pick(r, ["type", "node_type", "nodeType"]));
    if (t === TOOL_RESULT_CONTENT_TEXT) {
      const text = normalizeString(shared.pick(r, ["text_content", "textContent"]));
      if (!text || shared.isPlaceholderMessage(text)) continue;
      if (lastText && lastText === text) continue;
      out.push({ type: "text", text });
      lastText = text;
    } else if (t === TOOL_RESULT_CONTENT_IMAGE) {
      const img = shared.asRecord(shared.pick(r, ["image_content", "imageContent"]));
      const data = normalizeString(shared.pick(img, ["image_data", "imageData"]));
      if (!data) continue;
      out.push({ type: "image", source: { type: "base64", media_type: shared.mapImageFormatToMimeType(shared.pick(img, ["format"])), data } });
      lastText = "";
    }
  }
  if (out.length) return out;
  return String(fallbackText || "");
}

function buildAnthropicUserContentBlocks(message, nodes, includeToolResults) {
  const blocks = [];
  let lastText = null;
  const pushText = (text) => {
    const trimmed = String(text || "").trim();
    if (!trimmed || shared.isPlaceholderMessage(trimmed)) return;
    if (lastText === trimmed) return;
    blocks.push({ type: "text", text: String(text) });
    lastText = trimmed;
  };
  pushText(message);
  for (const node of shared.asArray(nodes)) {
    const r = shared.asRecord(node);
    const t = shared.normalizeNodeType(r);
    if (t === REQUEST_NODE_TEXT) {
      const tn = shared.asRecord(shared.pick(r, ["text_node", "textNode"]));
      pushText(shared.pick(tn, ["content"]));
    } else if (t === REQUEST_NODE_TOOL_RESULT) {
      if (!includeToolResults) continue;
      const tr = shared.asRecord(shared.pick(r, ["tool_result_node", "toolResultNode"]));
      const toolUseId = normalizeString(shared.pick(tr, ["tool_use_id", "toolUseId"]));
      if (!toolUseId) continue;
      blocks.push({ type: "tool_result", tool_use_id: toolUseId, content: buildAnthropicToolResultContent(shared.pick(tr, ["content"]), shared.pick(tr, ["content_nodes", "contentNodes"])), is_error: Boolean(shared.pick(tr, ["is_error", "isError"])) });
      lastText = null;
    } else if (t === REQUEST_NODE_IMAGE) {
      const img = shared.asRecord(shared.pick(r, ["image_node", "imageNode"]));
      const data = normalizeString(shared.pick(img, ["image_data", "imageData"]));
      if (!data) continue;
      blocks.push({ type: "image", source: { type: "base64", media_type: shared.mapImageFormatToMimeType(shared.pick(img, ["format"])), data } });
      lastText = null;
    } else if (t === REQUEST_NODE_IMAGE_ID) pushText(shared.formatImageIdForPrompt(shared.pick(r, ["image_id_node", "imageIdNode"])));
    else if (t === REQUEST_NODE_IDE_STATE) pushText(shared.formatIdeStateForPrompt(shared.pick(r, ["ide_state_node", "ideStateNode"])));
    else if (t === REQUEST_NODE_EDIT_EVENTS) pushText(shared.formatEditEventsForPrompt(shared.pick(r, ["edit_events_node", "editEventsNode"])));
    else if (t === REQUEST_NODE_CHECKPOINT_REF) pushText(shared.formatCheckpointRefForPrompt(shared.pick(r, ["checkpoint_ref_node", "checkpointRefNode"])));
    else if (t === REQUEST_NODE_CHANGE_PERSONALITY) pushText(shared.formatChangePersonalityForPrompt(shared.pick(r, ["change_personality_node", "changePersonalityNode"])));
    else if (t === REQUEST_NODE_FILE) pushText(shared.formatFileNodeForPrompt(shared.pick(r, ["file_node", "fileNode"])));
    else if (t === REQUEST_NODE_FILE_ID) pushText(shared.formatFileIdForPrompt(shared.pick(r, ["file_id_node", "fileIdNode"])));
    else if (t === REQUEST_NODE_HISTORY_SUMMARY) pushText(shared.formatHistorySummaryForPrompt(shared.pick(r, ["history_summary_node", "historySummaryNode"])));
  }
  return blocks;
}

function buildAnthropicAssistantContentBlocks(text, outNodes) {
  const blocks = [];
  const t = normalizeString(text);
  if (t) blocks.push({ type: "text", text: t });
  const nodes = shared.asArray(outNodes);
  const toolUse = [];
  const toolUseStart = [];
  for (const n of nodes) {
    const r = shared.asRecord(n);
    const nt = shared.normalizeNodeType(r);
    if (nt === RESPONSE_NODE_TOOL_USE) toolUse.push(r);
    else if (nt === RESPONSE_NODE_TOOL_USE_START) toolUseStart.push(r);
  }
  const chosen = toolUse.length ? toolUse : toolUseStart;
  const seen = new Set();
  for (const n of chosen) {
    const tu = shared.asRecord(shared.pick(n, ["tool_use", "toolUse"]));
    const toolUseId = normalizeString(shared.pick(tu, ["tool_use_id", "toolUseId"]));
    const toolName = normalizeString(shared.pick(tu, ["tool_name", "toolName"]));
    if (!toolUseId || !toolName || seen.has(toolUseId)) continue;
    seen.add(toolUseId);
    blocks.push({ type: "tool_use", id: toolUseId, name: toolName, input: shared.parseJsonObjectOrEmpty(shared.pick(tu, ["input_json", "inputJson"])) });
  }
  return blocks;
}

function buildAnthropicToolResultsBlocks(nodes) {
  const blocks = [];
  for (const node of shared.asArray(nodes)) {
    const r = shared.asRecord(node);
    if (shared.normalizeNodeType(r) !== REQUEST_NODE_TOOL_RESULT) continue;
    const tr = shared.asRecord(shared.pick(r, ["tool_result_node", "toolResultNode"]));
    const toolUseId = normalizeString(shared.pick(tr, ["tool_use_id", "toolUseId"]));
    if (!toolUseId) continue;
    blocks.push({ type: "tool_result", tool_use_id: toolUseId, content: buildAnthropicToolResultContent(shared.pick(tr, ["content"]), shared.pick(tr, ["content_nodes", "contentNodes"])), is_error: Boolean(shared.pick(tr, ["is_error", "isError"])) });
  }
  return blocks;
}

function buildAnthropicMessages(req) {
  const messages = [];

  const { processedHistory, processedRequestNodes } = getChatHistoryAndRequestNodesForAPI(req);
  const history = shared.asArray(processedHistory);

  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    const reqNodes = shared.collectExchangeRequestNodes(h);
    const userBlocks = buildAnthropicUserContentBlocks(h.request_message, reqNodes, false);
    if (userBlocks.length) messages.push({ role: "user", content: userBlocks.length === 1 && userBlocks[0].type === "text" ? userBlocks[0].text : userBlocks });
    const outNodes = shared.collectExchangeOutputNodes(h);
    const assistantText = normalizeString(h.response_text) ? h.response_text : shared.extractAssistantTextFromOutputNodes(outNodes);
    const assistantBlocks = buildAnthropicAssistantContentBlocks(assistantText, outNodes);
    if (assistantBlocks.length) messages.push({ role: "assistant", content: assistantBlocks.length === 1 && assistantBlocks[0].type === "text" ? assistantBlocks[0].text : assistantBlocks });
    const next = i + 1 < history.length ? history[i + 1] : null;
    if (next) {
      const trBlocks = buildAnthropicToolResultsBlocks(shared.collectExchangeRequestNodes(next));
      if (trBlocks.length) messages.push({ role: "user", content: trBlocks });
    }
  }
  const currentNodes = shared.asArray(processedRequestNodes);
  const nonToolNodes = currentNodes.filter((n) => shared.normalizeNodeType(n) !== REQUEST_NODE_TOOL_RESULT);
  const extraTextParts = shared.buildUserExtraTextParts(req, { hasNodes: nonToolNodes.length > 0 });
  const userBlocks = buildAnthropicUserContentBlocks(req.message, currentNodes, true);
  for (const t of shared.asArray(extraTextParts)) {
    const s = String(t ?? "").trim();
    if (s) userBlocks.push({ type: "text", text: s });
  }
  if (userBlocks.length) messages.push({ role: "user", content: userBlocks.length === 1 && userBlocks[0].type === "text" ? userBlocks[0].text : userBlocks });
  return messages;
}

module.exports = { buildAnthropicMessages };
