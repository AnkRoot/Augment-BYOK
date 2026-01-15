"use strict";

const { normalizeString } = require("../infra/util");
const shared = require("./augment-chat.shared");
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
  REQUEST_NODE_HISTORY_SUMMARY
} = require("./augment-protocol");

function buildOpenAiUserSegments(message, nodes) {
  const segments = [];
  let lastText = null;
  const pushText = (text) => {
    const trimmed = String(text || "").trim();
    if (!trimmed || shared.isPlaceholderMessage(trimmed)) return;
    if (lastText === trimmed) return;
    segments.push({ kind: "text", text: String(text) });
    lastText = trimmed;
  };
  const pushTextFromValue = (label, value) => pushText(shared.formatNodeValue(label, value));
  pushText(message);
  for (const node of shared.asArray(nodes)) {
    const r = shared.asRecord(node);
    const t = shared.normalizeNodeType(r);
    if (t === REQUEST_NODE_TEXT) {
      const tn = shared.asRecord(shared.pick(r, ["text_node", "textNode"]));
      pushText(shared.pick(tn, ["content"]));
    } else if (t === REQUEST_NODE_TOOL_RESULT) {
      continue;
    } else if (t === REQUEST_NODE_IMAGE) {
      const img = shared.asRecord(shared.pick(r, ["image_node", "imageNode"]));
      const data = normalizeString(shared.pick(img, ["image_data", "imageData"]));
      if (!data) continue;
      segments.push({ kind: "image", media_type: shared.mapImageFormatToMimeType(shared.pick(img, ["format"])), data });
      lastText = null;
    } else if (t === REQUEST_NODE_IMAGE_ID) pushTextFromValue("ImageId", shared.pick(r, ["image_id_node", "imageIdNode"]));
    else if (t === REQUEST_NODE_IDE_STATE) pushTextFromValue("IdeState", shared.pick(r, ["ide_state_node", "ideStateNode"]));
    else if (t === REQUEST_NODE_EDIT_EVENTS) pushTextFromValue("EditEvents", shared.pick(r, ["edit_events_node", "editEventsNode"]));
    else if (t === REQUEST_NODE_CHECKPOINT_REF) pushTextFromValue("CheckpointRef", shared.pick(r, ["checkpoint_ref_node", "checkpointRefNode"]));
    else if (t === REQUEST_NODE_CHANGE_PERSONALITY) pushTextFromValue("ChangePersonality", shared.pick(r, ["change_personality_node", "changePersonalityNode"]));
    else if (t === REQUEST_NODE_FILE) pushTextFromValue("File", shared.pick(r, ["file_node", "fileNode"]));
    else if (t === REQUEST_NODE_FILE_ID) pushTextFromValue("FileId", shared.pick(r, ["file_id_node", "fileIdNode"]));
    else if (t === REQUEST_NODE_HISTORY_SUMMARY) pushTextFromValue("HistorySummary", shared.pick(r, ["history_summary_node", "historySummaryNode"]));
  }
  return segments;
}

function buildOpenAiMessageContent(segments) {
  const segs = shared.asArray(segments);
  if (!segs.length) return null;
  const hasImage = segs.some((s) => s && s.kind === "image");
  if (!hasImage) {
    const parts = segs.filter((s) => s && s.kind === "text").map((s) => String(s.text || "").trim()).filter(Boolean);
    const text = parts.join("\n\n").trim();
    return text ? text : null;
  }
  const out = [];
  let textBuf = "";
  const flushText = () => {
    const t = textBuf.trim();
    if (t) out.push({ type: "text", text: t });
    textBuf = "";
  };
  for (const s of segs) {
    if (!s || typeof s !== "object") continue;
    if (s.kind === "text") {
      const t = String(s.text || "").trim();
      if (!t) continue;
      if (textBuf) textBuf += "\n\n";
      textBuf += t;
    } else if (s.kind === "image") {
      flushText();
      const data = String(s.data || "").trim();
      const media_type = normalizeString(s.media_type) || "image/png";
      if (!data) continue;
      out.push({ type: "image_url", image_url: { url: `data:${media_type};base64,${data}` } });
    }
  }
  flushText();
  return out.length ? out : null;
}

function buildOpenAiToolResultText(fallbackText, contentNodes) {
  const nodes = shared.asArray(contentNodes);
  const parts = [];
  let lastText = "";
  for (const n of nodes) {
    const r = shared.asRecord(n);
    const t = Number(shared.pick(r, ["type", "node_type", "nodeType"]));
    if (t === 1) {
      const text = normalizeString(shared.pick(r, ["text_content", "textContent"]));
      if (!text || shared.isPlaceholderMessage(text)) continue;
      if (lastText && lastText === text) continue;
      parts.push(text);
      lastText = text;
    } else if (t === 2) {
      const img = shared.asRecord(shared.pick(r, ["image_content", "imageContent"]));
      const data = normalizeString(shared.pick(img, ["image_data", "imageData"]));
      if (!data) continue;
      parts.push(`[image omitted: format=${Number(shared.pick(img, ["format"])) || 0} bytes≈${Math.floor((data.length * 3) / 4)}]`);
      lastText = "";
    }
  }
  if (parts.length) return parts.join("\n\n").trim();
  return String(fallbackText || "").trim();
}

function buildOpenAiToolMessagesFromRequestNodes(nodes) {
  const out = [];
  for (const node of shared.asArray(nodes)) {
    const r = shared.asRecord(node);
    if (shared.normalizeNodeType(r) !== REQUEST_NODE_TOOL_RESULT) continue;
    const tr = shared.asRecord(shared.pick(r, ["tool_result_node", "toolResultNode"]));
    const toolUseId = normalizeString(shared.pick(tr, ["tool_use_id", "toolUseId"]));
    if (!toolUseId) continue;
    const content = buildOpenAiToolResultText(shared.pick(tr, ["content"]), shared.pick(tr, ["content_nodes", "contentNodes"]));
    out.push({ role: "tool", tool_call_id: toolUseId, content: content || "" });
  }
  return out;
}

function buildOpenAiMessages(req) {
  const system = shared.buildSystemPrompt(req);
  const messages = [];
  if (normalizeString(system)) messages.push({ role: "system", content: system.trim() });
  const history = shared.asArray(req.chat_history);
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    const reqNodes = [...shared.asArray(h.request_nodes), ...shared.asArray(h.structured_request_nodes), ...shared.asArray(h.nodes)];
    const content = buildOpenAiMessageContent(buildOpenAiUserSegments(h.request_message, reqNodes));
    if (content) messages.push({ role: "user", content });
    const outNodes = [...shared.asArray(h.response_nodes), ...shared.asArray(h.structured_output_nodes)];
    const assistantText = normalizeString(h.response_text) ? h.response_text : shared.extractAssistantTextFromOutputNodes(outNodes);
    const toolCalls = shared.extractToolCallsFromOutputNodes(outNodes);
    if (normalizeString(assistantText) || toolCalls.length) messages.push({ role: "assistant", content: normalizeString(assistantText) ? assistantText.trim() : "", ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    const next = i + 1 < history.length ? history[i + 1] : null;
    if (next) messages.push(...buildOpenAiToolMessagesFromRequestNodes([...shared.asArray(next.request_nodes), ...shared.asArray(next.structured_request_nodes), ...shared.asArray(next.nodes)]));
  }
  const currentNodes = [...shared.asArray(req.nodes), ...shared.asArray(req.structured_request_nodes), ...shared.asArray(req.request_nodes)];
  messages.push(...buildOpenAiToolMessagesFromRequestNodes(currentNodes));
  if (normalizeString(req.message) && !shared.isPlaceholderMessage(req.message)) {
    const content = buildOpenAiMessageContent(buildOpenAiUserSegments(req.message, currentNodes));
    if (content) messages.push({ role: "user", content });
  }
  return messages;
}

module.exports = { buildOpenAiMessages };

