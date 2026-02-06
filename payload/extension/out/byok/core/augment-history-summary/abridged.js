"use strict";

const { normalizeString } = require("../../infra/util");
const shared = require("../augment-chat/shared");
const {
  REQUEST_NODE_TOOL_RESULT,
  REQUEST_NODE_IMAGE,
  REQUEST_NODE_IMAGE_ID,
  REQUEST_NODE_FILE,
  REQUEST_NODE_FILE_ID,
  RESPONSE_NODE_TOOL_USE,
  RESPONSE_NODE_TOOL_USE_START
} = require("../augment-protocol");

function exchangeRequestNodes(h) {
  const it = shared.asRecord(h);
  return [...shared.asArray(it.request_nodes), ...shared.asArray(it.structured_request_nodes), ...shared.asArray(it.nodes)];
}

function exchangeResponseNodes(h) {
  const it = shared.asRecord(h);
  return [...shared.asArray(it.response_nodes), ...shared.asArray(it.structured_output_nodes)];
}

function nodeHasImageOrFileMarker(n) {
  const t = shared.normalizeNodeType(n);
  const hasImage = t === REQUEST_NODE_IMAGE || t === REQUEST_NODE_IMAGE_ID || shared.pick(n, ["image_node", "imageNode"]) != null || shared.pick(n, ["image_id_node", "imageIdNode"]) != null;
  const hasFile = t === REQUEST_NODE_FILE || t === REQUEST_NODE_FILE_ID || shared.pick(n, ["file_node", "fileNode"]) != null || shared.pick(n, ["file_id_node", "fileIdNode"]) != null;
  return { hasImage, hasFile };
}

function buildUserMessageWithAttachments(h) {
  const it = shared.asRecord(h);
  let msg = shared.asString(it.request_message);
  let hasImage = false;
  let hasFile = false;
  for (const n of exchangeRequestNodes(it)) {
    const { hasImage: i, hasFile: f } = nodeHasImageOrFileMarker(n);
    hasImage ||= i;
    hasFile ||= f;
    if (hasImage && hasFile) break;
  }
  if (hasImage) msg += "\n[User attached image]";
  if (hasFile) msg += "\n[User attached document]";
  return msg;
}

function iterResponseToolUses(h) {
  const out = [];
  for (const n of exchangeResponseNodes(h)) {
    const t = shared.normalizeNodeType(n);
    if (t !== RESPONSE_NODE_TOOL_USE && t !== RESPONSE_NODE_TOOL_USE_START) continue;
    const tu = shared.asRecord(shared.pick(n, ["tool_use", "toolUse"]));
    const toolName = shared.asString(shared.pick(tu, ["tool_name", "toolName"])).trim();
    const inputJson = shared.asString(shared.pick(tu, ["input_json", "inputJson"]));
    if (!toolName) continue;
    out.push({ toolName, inputJson });
  }
  return out;
}

function addToolUseToActions(toolUse, actions) {
  const toolName = normalizeString(toolUse?.toolName);
  const inputJson = shared.asString(toolUse?.inputJson);
  if (!toolName || !inputJson) return;
  let v;
  try { v = JSON.parse(inputJson); } catch { return; }
  const add = (set, p) => { const s = normalizeString(p); if (s) set.add(s); };
  if (toolName === "str-replace-editor") add(actions.files_modified, v?.path);
  else if (toolName === "save-file") add(actions.files_created, v?.path);
  else if (toolName === "remove-files") for (const p of shared.asArray(v?.file_paths)) add(actions.files_deleted, p);
  else if (toolName === "view") add(actions.files_viewed, v?.path);
  else if (toolName === "launch-process") add(actions.terminal_commands, v?.command);
}

function finalizeActions(actions) {
  for (const p of actions.files_modified) actions.files_viewed.delete(p);
}

function middleTruncateWithEllipsis(s, limit) {
  const str = shared.asString(s);
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return "";
  const chars = Array.from(str);
  if (chars.length <= n) return str;
  if (n <= 3) return ".".repeat(n);
  const keep = n - 3;
  const start = Math.floor(keep * 0.5);
  const end = keep - start;
  return `${chars.slice(0, start).join("")}...${chars.slice(chars.length - end).join("")}`;
}

function limitSetItems(set, maxItems, itemCharLimit, noun) {
  const items = Array.from(set instanceof Set ? set : []).map((x) => normalizeString(x)).filter(Boolean).sort();
  const max = Number.isFinite(Number(maxItems)) && Number(maxItems) > 0 ? Math.floor(Number(maxItems)) : 0;
  if (!max) return [];
  const trunc = (s) => middleTruncateWithEllipsis(s, itemCharLimit);
  if (items.length <= max) return items.map(trunc);
  const out = items.slice(0, max).map(trunc);
  out.push(`... ${items.length - max} more ${normalizeString(noun) || "items"}`);
  return out;
}

function renderAbridgedEntry(entry, params) {
  const p = shared.asRecord(params);
  let userMessage = shared.asString(entry?.user_message);
  if (Array.from(userMessage).length > Number(p.userMessageCharsLimit)) userMessage = middleTruncateWithEllipsis(userMessage, p.userMessageCharsLimit);
  let agentResponse = shared.asString(entry?.agent_final_response);
  if (Array.from(agentResponse).length > Number(p.agentResponseCharsLimit)) agentResponse = middleTruncateWithEllipsis(agentResponse, p.agentResponseCharsLimit);

  const actions = entry?.agent_actions_summary || {};
  const hasActions = (actions.files_modified && actions.files_modified.size) || (actions.files_created && actions.files_created.size) || (actions.files_deleted && actions.files_deleted.size) || (actions.files_viewed && actions.files_viewed.size) || (actions.terminal_commands && actions.terminal_commands.size);

  const out = [];
  if (userMessage.trim()) out.push("<user_request>\n" + userMessage.trimEnd() + "\n</user_request>");
  if (hasActions) {
    out.push("<agent_actions_summary>");
    const addList = (tag, items) => { if (!items.length) return; out.push(`<${tag}>`); for (const it of items) out.push(it); out.push(`</${tag}>`); };
    addList("files_modified", limitSetItems(actions.files_modified, p.numFilesModifiedLimit, p.actionCharsLimit, "files"));
    addList("files_created", limitSetItems(actions.files_created, p.numFilesCreatedLimit, p.actionCharsLimit, "files"));
    addList("files_deleted", limitSetItems(actions.files_deleted, p.numFilesDeletedLimit, p.actionCharsLimit, "files"));
    addList("files_viewed", limitSetItems(actions.files_viewed, p.numFilesViewedLimit, p.actionCharsLimit, "files"));
    addList("terminal_commands", limitSetItems(actions.terminal_commands, p.numTerminalCommandsLimit, p.actionCharsLimit, "commands"));
    out.push("</agent_actions_summary>");
  }
  if (agentResponse.trim()) out.push("<agent_response>\n" + agentResponse.trimEnd() + "\n</agent_response>");
  else if (entry?.was_interrupted) out.push("<agent_was_interrupted/>");
  else if (entry?.continues) out.push("<agent_continues/>");
  return out.join("\n").trim();
}

function buildAbridgedEntries(history) {
  const out = [];
  let current = null;
  for (const raw of shared.asArray(history)) {
    const h = shared.asRecord(raw);
    const isToolResultExchange = exchangeRequestNodes(h).some((n) => shared.normalizeNodeType(n) === REQUEST_NODE_TOOL_RESULT);
    if (!isToolResultExchange) {
      if (current) { if (!shared.asString(current.agent_final_response).trim()) current.was_interrupted = true; out.push(current); }
      current = { user_message: buildUserMessageWithAttachments(h), agent_actions_summary: { files_modified: new Set(), files_created: new Set(), files_deleted: new Set(), files_viewed: new Set(), terminal_commands: new Set() }, agent_final_response: "", was_interrupted: false, continues: false };
    }
    if (!current) continue;
    const toolUses = iterResponseToolUses(h);
    for (const tu of toolUses) addToolUseToActions(tu, current.agent_actions_summary);
    if (!toolUses.length) {
      const respText = shared.asString(h.response_text).trim();
      const respFromNodes = shared.extractAssistantTextFromOutputNodes(exchangeResponseNodes(h));
      const finalText = respText || respFromNodes;
      if (finalText.trim()) current.agent_final_response = finalText;
    }
  }
  if (current) { if (!shared.asString(current.agent_final_response).trim()) current.continues = true; out.push(current); }
  for (const e of out) finalizeActions(e.agent_actions_summary);
  return out;
}

function buildAbridgedHistoryText(history, params, untilRequestId) {
  const hs = shared.asArray(history);
  const limit = Number.isFinite(Number(params?.totalCharsLimit)) && Number(params.totalCharsLimit) > 0 ? Math.floor(Number(params.totalCharsLimit)) : 0;
  let slice = hs;
  const untilIdxRaw = typeof untilRequestId === "number" ? untilRequestId : null;
  const untilIdx = untilIdxRaw != null && Number.isFinite(Number(untilIdxRaw)) ? Math.floor(Number(untilIdxRaw)) : null;
  if (untilIdx != null) {
    const idx = Math.max(0, Math.min(hs.length, untilIdx));
    slice = hs.slice(0, idx);
  } else {
    const rid = normalizeString(untilRequestId);
    if (rid) {
      const pos = hs.findIndex((h) => normalizeString(h?.request_id) === rid);
      if (pos >= 0) slice = hs.slice(0, pos);
    }
  }
  const entries = buildAbridgedEntries(slice);
  let total = 0;
  const renderedRev = [];
  let droppedBeginning = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const rendered = renderAbridgedEntry(entries[i], params);
    if (limit && total + rendered.length > limit) { droppedBeginning = i + 1; break; }
    total += rendered.length;
    renderedRev.push(rendered);
  }
  renderedRev.reverse();
  return { text: renderedRev.join("\n").trim(), droppedBeginning };
}

module.exports = { buildAbridgedHistoryText, exchangeRequestNodes, exchangeResponseNodes };
