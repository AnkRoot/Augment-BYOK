"use strict";

const { normalizeString } = require("../infra/util");
const {
  REQUEST_NODE_TEXT,
  REQUEST_NODE_TOOL_RESULT,
  REQUEST_NODE_IMAGE,
  REQUEST_NODE_IMAGE_ID,
  REQUEST_NODE_FILE,
  REQUEST_NODE_FILE_ID,
  REQUEST_NODE_CHANGE_PERSONALITY
} = require("./augment-protocol");

function hasToolResultNodes(req) {
  const r = req && typeof req === "object" ? req : {};
  const nodes = [];
  if (Array.isArray(r.nodes)) nodes.push(...r.nodes);
  if (Array.isArray(r.structured_request_nodes)) nodes.push(...r.structured_request_nodes);
  if (Array.isArray(r.request_nodes)) nodes.push(...r.request_nodes);

  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const t = Number(node.type ?? node.node_type ?? node.nodeType);
    if (t === REQUEST_NODE_TOOL_RESULT) return true;
  }
  return false;
}

function isUserDialogueTurn(req) {
  const r = req && typeof req === "object" ? req : {};
  if (normalizeString(r.message)) return true;

  // 部分场景会通过 selected_code/diff 等字段携带用户上下文（即使 message 为空）
  if (normalizeString(r.selected_code) || normalizeString(r.diff) || normalizeString(r.prefix) || normalizeString(r.suffix)) return true;

  const nodes = [];
  if (Array.isArray(r.nodes)) nodes.push(...r.nodes);
  if (Array.isArray(r.structured_request_nodes)) nodes.push(...r.structured_request_nodes);
  if (Array.isArray(r.request_nodes)) nodes.push(...r.request_nodes);

  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const t = Number(node.type ?? node.node_type ?? node.nodeType);
    if (!Number.isFinite(t)) continue;
    if (
      t === REQUEST_NODE_TEXT ||
      t === REQUEST_NODE_IMAGE ||
      t === REQUEST_NODE_IMAGE_ID ||
      t === REQUEST_NODE_FILE ||
      t === REQUEST_NODE_FILE_ID ||
      t === REQUEST_NODE_CHANGE_PERSONALITY
    ) {
      return true;
    }
  }

  return false;
}

function shouldRequestThinking(req) {
  return isUserDialogueTurn(req) && !hasToolResultNodes(req);
}

function stripThinkingAndReasoningFromRequestDefaults(requestDefaults) {
  const raw = requestDefaults && typeof requestDefaults === "object" && !Array.isArray(requestDefaults) ? requestDefaults : {};
  const hasThinkingOrReasoning =
    raw.thinking != null || raw.reasoning != null || raw.reasoning_effort != null || raw.reasoningEffort != null;
  if (!hasThinkingOrReasoning) return raw;

  const out = { ...raw };
  if ("thinking" in out) delete out.thinking;
  if ("reasoning" in out) delete out.reasoning;
  if ("reasoning_effort" in out) delete out.reasoning_effort;
  if ("reasoningEffort" in out) delete out.reasoningEffort;
  return out;
}

module.exports = { hasToolResultNodes, isUserDialogueTurn, shouldRequestThinking, stripThinkingAndReasoningFromRequestDefaults };
