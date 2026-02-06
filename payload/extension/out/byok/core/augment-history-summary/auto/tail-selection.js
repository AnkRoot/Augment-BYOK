"use strict";

const { normalizeString } = require("../../../infra/util");
const shared = require("../../augment-chat/shared");
const { exchangeRequestNodes } = require("../abridged");
const { REQUEST_NODE_TOOL_RESULT } = require("../../augment-protocol");

const { asArray, pick, normalizeNodeType } = shared;

const { estimateExchangeSizeBytes } = require("./estimate");

function nodeIsToolResult(n) {
  if (normalizeNodeType(n) !== REQUEST_NODE_TOOL_RESULT) return false;
  const tr = pick(n, ["tool_result_node", "toolResultNode"]);
  return tr && typeof tr === "object" && !Array.isArray(tr);
}

function exchangeHasToolResults(h) {
  return exchangeRequestNodes(h).some(nodeIsToolResult);
}

function splitHistoryForSummary(history, tailSizeBytesToExclude, minTailExchanges) {
  const hs = asArray(history);
  if (!hs.length) return { head: [], tail: [] };
  const headRev = [];
  const tailRev = [];
  let seenBytes = 0;
  for (let i = hs.length - 1; i >= 0; i--) {
    const ex = hs[i];
    const sz = estimateExchangeSizeBytes(ex);
    if (seenBytes + sz < tailSizeBytesToExclude || tailRev.length < minTailExchanges) {
      tailRev.push(ex);
    } else {
      headRev.push(ex);
    }
    seenBytes += sz;
  }
  headRev.reverse();
  tailRev.reverse();
  return { head: headRev, tail: tailRev };
}

function adjustTailToAvoidToolResultOrphans(original, tailStart) {
  const hs = asArray(original);
  let start = Number.isFinite(Number(tailStart)) ? Math.floor(Number(tailStart)) : 0;
  while (start < hs.length) {
    if (!exchangeHasToolResults(hs[start])) break;
    if (start <= 0) break;
    start -= 1;
  }
  return start;
}

function computeTailSelection({ history, hs, decision }) {
  const hist = asArray(history);
  const split = splitHistoryForSummary(hist, decision.tailExcludeChars, hs.minTailExchanges);
  if (!split.head.length || !split.tail.length) return null;

  let tailStart = -1;
  const splitBoundaryRequestId = normalizeString(split.tail[0]?.request_id);
  if (splitBoundaryRequestId) {
    tailStart = hist.findIndex((h) => normalizeString(h?.request_id) === splitBoundaryRequestId);
  }
  if (tailStart < 0) tailStart = Math.max(0, hist.length - split.tail.length);

  tailStart = adjustTailToAvoidToolResultOrphans(hist, tailStart);
  const boundaryRequestId = normalizeString(hist[tailStart]?.request_id);
  const droppedHead = hist.slice(0, tailStart);
  const tail = hist.slice(tailStart);
  if (!droppedHead.length || !tail.length) return null;
  return { tailStart, boundaryRequestId, droppedHead, tail };
}

module.exports = { computeTailSelection };
