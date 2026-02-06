"use strict";

const shared = require("../augment-struct");
const { truncateTextMiddle } = require("../../infra/text");
const {
  REQUEST_NODE_TEXT,
  REQUEST_NODE_TOOL_RESULT,
  REQUEST_NODE_HISTORY_SUMMARY,
  RESPONSE_NODE_RAW_RESPONSE,
  RESPONSE_NODE_THINKING,
  RESPONSE_NODE_TOOL_USE
} = require("../augment-protocol");

const { asRecord, asArray, asString, pick, normalizeNodeType } = shared;

const HISTORY_SUMMARY_TOOL_RESULT_MAX_CHARS = 8000;
const HISTORY_SUMMARY_TOOL_RESULT_TAIL_CHARS = 512;
const HISTORY_SUMMARY_TOOL_USE_INPUT_MAX_CHARS = 2000;
const HISTORY_SUMMARY_TOOL_USE_INPUT_TAIL_CHARS = 256;
const HISTORY_SUMMARY_END_PART_FULL_DEFAULT_TAIL_CHARS = 2048;

const EMERGENCY_CONTEXT_COMPACTION_LEVELS = [
  null,
  { endPartFullMaxChars: 60000, endPartFullTailChars: 12000, maxHistoryEndExchanges: 8, maxChatHistoryExchanges: 12 },
  { endPartFullMaxChars: 30000, endPartFullTailChars: 10000, maxHistoryEndExchanges: 4, maxChatHistoryExchanges: 6 },
  { endPartFullMaxChars: 15000, endPartFullTailChars: 8000, maxHistoryEndExchanges: 2, maxChatHistoryExchanges: 3 },
  { endPartFullMaxChars: 4000, endPartFullTailChars: 2000, maxHistoryEndExchanges: 1, maxChatHistoryExchanges: 1 }
];

function normalizeJoinedLines(lines) {
  let out = "";
  for (const raw of lines) {
    const line = asString(raw).replace(/\n+$/g, "");
    if (!line.trim()) continue;
    if (out) out += "\n";
    out += line;
  }
  return out;
}

function extractUserMessageFromRequestNodes(nodes, fallback) {
  const joined = normalizeJoinedLines(
    asArray(nodes)
      .filter((n) => normalizeNodeType(n) === REQUEST_NODE_TEXT)
      .map((n) => asString(pick(pick(n, ["text_node", "textNode"]), ["content"])))
  );
  const fb = asString(fallback);
  return joined.trim() ? joined : fb;
}

function buildExchangeRenderCtx(ex) {
  const r = asRecord(ex);
  const requestMessage = asString(pick(r, ["request_message", "requestMessage"])) || "";
  const requestNodes = asArray(pick(r, ["request_nodes", "requestNodes"]));
  const responseNodes = asArray(pick(r, ["response_nodes", "responseNodes"]));
  const responseTextFallback = asString(pick(r, ["response_text", "responseText"])) || "";

  const userMessageFromNodes = requestNodes
    .filter((n) => normalizeNodeType(n) === REQUEST_NODE_TEXT && pick(n, ["text_node", "textNode"]) != null)
    .map((n) => asString(pick(pick(n, ["text_node", "textNode"]), ["content"])))
    .join("\n");
  const userMessage = userMessageFromNodes || requestMessage;

  const toolResults = requestNodes
    .filter((n) => normalizeNodeType(n) === REQUEST_NODE_TOOL_RESULT && pick(n, ["tool_result_node", "toolResultNode"]) != null)
    .map((n) => asRecord(pick(n, ["tool_result_node", "toolResultNode"])))
    .filter((tr) => asString(pick(tr, ["tool_use_id", "toolUseId"])).trim())
    .map((tr) => ({
      id: asString(pick(tr, ["tool_use_id", "toolUseId"])),
      content: truncateTextMiddle(asString(pick(tr, ["content"])), HISTORY_SUMMARY_TOOL_RESULT_MAX_CHARS, { tailChars: HISTORY_SUMMARY_TOOL_RESULT_TAIL_CHARS }),
      isError: Boolean(pick(tr, ["is_error", "isError"]))
    }));

  const thinking = responseNodes
    .filter((n) => normalizeNodeType(n) === RESPONSE_NODE_THINKING && pick(n, ["thinking", "thinking_node", "thinkingNode"]) != null)
    .map((n) => {
      const th = asRecord(pick(n, ["thinking", "thinking_node", "thinkingNode"]));
      return asString(pick(th, ["content", "summary"]));
    })
    .filter((s) => s.length > 0)
    .join("\n");

  const responseTextFromNodes = responseNodes
    .filter((n) => normalizeNodeType(n) === RESPONSE_NODE_RAW_RESPONSE)
    .map((n) => asString(pick(n, ["content"])))
    .join("\n");
  const responseText = responseTextFromNodes || responseTextFallback;

  const toolUses = responseNodes
    .filter((n) => normalizeNodeType(n) === RESPONSE_NODE_TOOL_USE && pick(n, ["tool_use", "toolUse"]) != null)
    .map((n) => asRecord(pick(n, ["tool_use", "toolUse"])))
    .filter((tu) => asString(pick(tu, ["tool_use_id", "toolUseId"])).trim() && asString(pick(tu, ["tool_name", "toolName"])).trim())
    .map((tu) => ({
      name: asString(pick(tu, ["tool_name", "toolName"])),
      id: asString(pick(tu, ["tool_use_id", "toolUseId"])),
      input: truncateTextMiddle(asString(pick(tu, ["input_json", "inputJson"])), HISTORY_SUMMARY_TOOL_USE_INPUT_MAX_CHARS, { tailChars: HISTORY_SUMMARY_TOOL_USE_INPUT_TAIL_CHARS })
    }));

  return {
    user_message: userMessage,
    tool_results: toolResults,
    has_response: Boolean(thinking || responseText || toolUses.length),
    thinking,
    response_text: responseText,
    tool_uses: toolUses
  };
}

function renderExchangeFull(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const out = [];
  out.push("<exchange>");
  out.push("  <user_request_or_tool_results>");
  out.push(asString(c.user_message));
  for (const tr of asArray(c.tool_results)) {
    out.push(`    <tool_result tool_use_id="${asString(tr?.id)}" is_error="${tr?.isError ? "true" : "false"}">`);
    out.push(asString(tr?.content));
    out.push("    </tool_result>");
  }
  out.push("  </user_request_or_tool_results>");
  if (c.has_response) {
    out.push("  <agent_response_or_tool_uses>");
    if (asString(c.thinking)) {
      out.push("    <thinking>");
      out.push(asString(c.thinking));
      out.push("    </thinking>");
    }
    out.push(asString(c.response_text));
    for (const tu of asArray(c.tool_uses)) {
      out.push(`    <tool_use name="${asString(tu?.name)}" tool_use_id="${asString(tu?.id)}">`);
      out.push(asString(tu?.input));
      out.push("    </tool_use>");
    }
    out.push("  </agent_response_or_tool_uses>");
  }
  out.push("</exchange>");
  return out.join("\n").trim();
}

function replacePlaceholders(template, repl) {
  const t = asString(template);
  const pairs = Array.isArray(repl) ? repl : [];
  if (!pairs.length) return t;

  const map = Object.create(null);
  for (const [k, v] of pairs) {
    const key = asString(k);
    if (!key) continue;
    map[key] = asString(v);
  }

  const keys = Object.keys(map);
  if (!keys.length) return t;

  const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(keys.map(escapeRegExp).join("|"), "g");
  return t.replace(re, (m) => (Object.prototype.hasOwnProperty.call(map, m) ? map[m] : m));
}

function normalizeHistoryEndExchange(raw) {
  const r = asRecord(raw);
  return {
    request_message: asString(pick(r, ["request_message", "requestMessage"])),
    response_text: asString(pick(r, ["response_text", "responseText"])),
    request_nodes: asArray(pick(r, ["request_nodes", "requestNodes"])),
    response_nodes: asArray(pick(r, ["response_nodes", "responseNodes"]))
  };
}

function renderHistorySummaryNodeValue(v, extraToolResults) {
  const r = asRecord(v);
  const messageTemplate = asString(pick(r, ["message_template", "messageTemplate"]));
  if (!messageTemplate.trim()) return null;

  const summaryText = asString(pick(r, ["summary_text", "summaryText"]));
  const summarizationRequestId = asString(pick(r, ["summarization_request_id", "summarizationRequestId"]));
  const historyBeginningDroppedNumExchanges = Number(pick(r, ["history_beginning_dropped_num_exchanges", "historyBeginningDroppedNumExchanges"])) || 0;
  const historyMiddleAbridgedText = asString(pick(r, ["history_middle_abridged_text", "historyMiddleAbridgedText"]));
  const historyEnd = asArray(pick(r, ["history_end", "historyEnd"])).map(normalizeHistoryEndExchange);
  const extra = asArray(extraToolResults);
  if (extra.length) historyEnd.push({ request_message: "", response_text: "", request_nodes: extra, response_nodes: [] });

  const endPartFull = historyEnd.map(buildExchangeRenderCtx).map(renderExchangeFull).join("\n");
  const endPartFullMaxChars = Number(pick(r, ["end_part_full_max_chars", "endPartFullMaxChars"])) || 0;
  const endPartFullTailChars = Number(pick(r, ["end_part_full_tail_chars", "endPartFullTailChars"])) || 0;
  const endPartFullFinal =
    endPartFullMaxChars > 0
      ? truncateTextMiddle(endPartFull, endPartFullMaxChars, {
          tailChars: endPartFullTailChars > 0 ? endPartFullTailChars : HISTORY_SUMMARY_END_PART_FULL_DEFAULT_TAIL_CHARS
        })
      : endPartFull;
  const abridged = historyMiddleAbridgedText;

  return replacePlaceholders(messageTemplate, [
    ["{summary}", summaryText],
    ["{summarization_request_id}", summarizationRequestId],
    ["{beginning_part_dropped_num_exchanges}", String(historyBeginningDroppedNumExchanges)],
    ["{middle_part_abridged}", abridged],
    ["{end_part_full}", endPartFullFinal],
  ]);
}

function hasHistorySummaryNode(nodes) {
  return asArray(nodes).some((n) => normalizeNodeType(n) === REQUEST_NODE_HISTORY_SUMMARY && pick(n, ["history_summary_node", "historySummaryNode"]) != null);
}

function chatHistoryItemHasSummary(item) {
  const it = asRecord(item);
  return hasHistorySummaryNode(pick(it, ["request_nodes", "requestNodes"])) || hasHistorySummaryNode(pick(it, ["structured_request_nodes", "structuredRequestNodes"])) || hasHistorySummaryNode(pick(it, ["nodes"]));
}

function extractHistorySummaryNodeFromNodes(nodes) {
  return asArray(nodes).find((n) => normalizeNodeType(n) === REQUEST_NODE_HISTORY_SUMMARY && pick(n, ["history_summary_node", "historySummaryNode"]) != null) || null;
}

function compactHistorySummaryExchange(exchange) {
  const ex = asRecord(exchange);
  const reqNodesAll = [...asArray(ex.request_nodes), ...asArray(ex.structured_request_nodes), ...asArray(ex.nodes)];
  const summaryNode = asRecord(extractHistorySummaryNodeFromNodes(reqNodesAll));
  const summaryValue = pick(summaryNode, ["history_summary_node", "historySummaryNode"]);
  if (!summaryValue) return exchange;

  const summaryId = Number(pick(summaryNode, ["id"])) || 0;
  const toolResults = reqNodesAll.filter((n) => normalizeNodeType(n) === REQUEST_NODE_TOOL_RESULT && pick(n, ["tool_result_node", "toolResultNode"]) != null);
  const otherNodes = reqNodesAll.filter((n) => {
    const t = normalizeNodeType(n);
    return t !== REQUEST_NODE_HISTORY_SUMMARY && t !== REQUEST_NODE_TOOL_RESULT;
  });

  const text = renderHistorySummaryNodeValue(summaryValue, toolResults);
  if (!text) return { ...exchange, request_nodes: otherNodes, structured_request_nodes: [], nodes: [] };

  const summaryTextNode = { id: summaryId, type: REQUEST_NODE_TEXT, content: "", text_node: { content: asString(text) } };
  return { ...exchange, request_nodes: [summaryTextNode, ...otherNodes], structured_request_nodes: [], nodes: [] };
}

function preprocessHistoryNew(exchanges) {
  const list = asArray(exchanges);
  if (!list.length) return list;

  let start = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (chatHistoryItemHasSummary(list[i])) { start = i; break; }
  }
  if (start === -1) return list;

  const out = list.slice(start);
  if (!out.length) return out;
  out[0] = compactHistorySummaryExchange(out[0]);
  return out;
}

function getChatHistoryAndRequestNodesForAPI(req) {
  const r = asRecord(req);
  const history = asArray(pick(r, ["chat_history", "chatHistory"]));
  const currentNodesAll = [...asArray(pick(r, ["nodes"])), ...asArray(pick(r, ["structured_request_nodes", "structuredRequestNodes"])), ...asArray(pick(r, ["request_nodes", "requestNodes"]))];

  const currentExchange = {
    request_id: "",
    request_message: "",
    response_text: "",
    request_nodes: currentNodesAll,
    structured_request_nodes: [],
    nodes: [],
    response_nodes: [],
    structured_output_nodes: []
  };

  const combined = history.concat([currentExchange]);
  const processed = preprocessHistoryNew(combined);
  if (!processed.length) return { processedHistory: history, processedRequestNodes: currentNodesAll };

  const last = asRecord(processed[processed.length - 1]);
  const processedRequestNodes = asArray(pick(last, ["request_nodes", "requestNodes"]));
  processed.pop();
  return { processedHistory: processed, processedRequestNodes: processedRequestNodes.length ? processedRequestNodes : currentNodesAll };
}

function resolveEmergencyContextCompactionPolicy(level) {
  const raw = Number(level);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const idx = Math.min(EMERGENCY_CONTEXT_COMPACTION_LEVELS.length - 1, Math.floor(raw));
  return EMERGENCY_CONTEXT_COMPACTION_LEVELS[idx] || EMERGENCY_CONTEXT_COMPACTION_LEVELS[EMERGENCY_CONTEXT_COMPACTION_LEVELS.length - 1] || null;
}

function collectRequestNodesFromExchange(exchange) {
  const ex = asRecord(exchange);
  return [...asArray(pick(ex, ["request_nodes", "requestNodes"])), ...asArray(pick(ex, ["structured_request_nodes", "structuredRequestNodes"])), ...asArray(pick(ex, ["nodes"]))];
}

function collectRequestNodesFromReq(req) {
  const r = asRecord(req);
  return [...asArray(pick(r, ["nodes"])), ...asArray(pick(r, ["structured_request_nodes", "structuredRequestNodes"])), ...asArray(pick(r, ["request_nodes", "requestNodes"]))];
}

function exchangeHasToolResults(exchange) {
  const nodes = collectRequestNodesFromExchange(exchange);
  return nodes.some(
    (n) => normalizeNodeType(n) === REQUEST_NODE_TOOL_RESULT && pick(n, ["tool_result_node", "toolResultNode"]) != null
  );
}

function dropToolResultOrphanStart(exchanges) {
  const xs = asArray(exchanges);
  let start = 0;
  while (start < xs.length && exchangeHasToolResults(xs[start])) start += 1;
  return start > 0 ? xs.slice(start) : xs;
}

function findLastHistorySummaryNodeValue(req) {
  const currentNodes = collectRequestNodesFromReq(req);
  const currentNode = extractHistorySummaryNodeFromNodes(currentNodes);
  if (currentNode) return { where: "current", node: currentNode, value: pick(currentNode, ["history_summary_node", "historySummaryNode"]) };

  const history = asArray(pick(asRecord(req), ["chat_history", "chatHistory"]));
  for (let i = history.length - 1; i >= 0; i--) {
    const ex = asRecord(history[i]);
    const nodes = collectRequestNodesFromExchange(ex);
    const node = extractHistorySummaryNodeFromNodes(nodes);
    if (node) return { where: "history", index: i, node: node, value: pick(node, ["history_summary_node", "historySummaryNode"]) };
  }

  return null;
}

function applyEmergencyContextCompactionForRetry(req, { level } = {}) {
  const r = req && typeof req === "object" && !Array.isArray(req) ? req : null;
  const policy = resolveEmergencyContextCompactionPolicy(level);
  if (!r || !policy) return { changed: false, kind: "none" };

  const found = findLastHistorySummaryNodeValue(r);
  if (found && found.value && typeof found.value === "object" && !Array.isArray(found.value)) {
    const v = found.value;
    let changed = false;

    const beforeHistoryEnd = asArray(pick(v, ["history_end", "historyEnd"]));
    let nextHistoryEnd = beforeHistoryEnd;
    const maxEx = Number(policy.maxHistoryEndExchanges);
    if (Number.isFinite(maxEx) && maxEx >= 0) {
      nextHistoryEnd = maxEx === 0 ? [] : beforeHistoryEnd.slice(Math.max(0, beforeHistoryEnd.length - maxEx));
      nextHistoryEnd = dropToolResultOrphanStart(nextHistoryEnd);
    }
    if (nextHistoryEnd.length !== beforeHistoryEnd.length) {
      v.history_end = nextHistoryEnd;
      v.historyEnd = nextHistoryEnd;
      changed = true;
    }

    if (Number.isFinite(Number(policy.endPartFullMaxChars)) && Number(policy.endPartFullMaxChars) > 0) {
      if (Number(pick(v, ["end_part_full_max_chars", "endPartFullMaxChars"])) !== Number(policy.endPartFullMaxChars)) {
        v.end_part_full_max_chars = Number(policy.endPartFullMaxChars);
        v.endPartFullMaxChars = Number(policy.endPartFullMaxChars);
        changed = true;
      }
    }
    if (Number.isFinite(Number(policy.endPartFullTailChars)) && Number(policy.endPartFullTailChars) > 0) {
      if (Number(pick(v, ["end_part_full_tail_chars", "endPartFullTailChars"])) !== Number(policy.endPartFullTailChars)) {
        v.end_part_full_tail_chars = Number(policy.endPartFullTailChars);
        v.endPartFullTailChars = Number(policy.endPartFullTailChars);
        changed = true;
      }
    }

    return {
      changed,
      kind: "summary",
      where: found.where,
      level: Math.floor(Number(level) || 0),
      historyEndBefore: beforeHistoryEnd.length,
      historyEndAfter: nextHistoryEnd.length,
      endPartFullMaxChars: Number(policy.endPartFullMaxChars) || 0
    };
  }

  const beforeHistory = Array.isArray(r.chat_history) ? r.chat_history : asArray(pick(r, ["chat_history", "chatHistory"]));
  const maxKeep = Number(policy.maxChatHistoryExchanges);
  if (!beforeHistory.length || !Number.isFinite(maxKeep) || maxKeep < 0) return { changed: false, kind: "none" };

  const sliced = maxKeep === 0 ? [] : beforeHistory.slice(Math.max(0, beforeHistory.length - Math.floor(maxKeep)));
  const cleaned = dropToolResultOrphanStart(sliced);
  const changed = cleaned.length !== beforeHistory.length;
  if (changed) r.chat_history = cleaned;

  return { changed, kind: "history", level: Math.floor(Number(level) || 0), chatHistoryBefore: beforeHistory.length, chatHistoryAfter: cleaned.length };
}

module.exports = { renderHistorySummaryNodeValue, getChatHistoryAndRequestNodesForAPI, applyEmergencyContextCompactionForRetry };
