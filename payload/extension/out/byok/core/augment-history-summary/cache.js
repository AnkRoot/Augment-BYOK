"use strict";

const { debug } = require("../../infra/log");
const { normalizeString } = require("../../infra/util");
const { asString } = require("../augment-chat/shared");
const {
  DEFAULT_SUMMARY_TAIL_REQUEST_IDS,
  exchangeRequestId,
  historyStartRequestId,
  tailRequestIds,
  computeRequestIdsHash,
  tailIdsEndsWith
} = require("./consistency");

const HISTORY_SUMMARY_CACHE_KEY = "augment-byok.historySummaryCache.v1";
const HISTORY_SUMMARY_CACHE = new Map();
const HISTORY_SUMMARY_CACHE_MAX_ENTRIES = 200;
let historySummaryCacheLoaded = false;
let historySummaryStorage = null;

function nowMs() {
  return Date.now();
}

function pruneHistorySummaryCache() {
  const maxEntries = HISTORY_SUMMARY_CACHE_MAX_ENTRIES;
  if (!Number.isFinite(Number(maxEntries)) || Number(maxEntries) <= 0) return 0;
  if (HISTORY_SUMMARY_CACHE.size <= maxEntries) return 0;

  const items = [];
  for (const [cid, v] of HISTORY_SUMMARY_CACHE.entries()) {
    const updatedAtMs = Number(v?.updatedAtMs) || 0;
    items.push({ cid, updatedAtMs });
  }
  items.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));

  const keep = new Set(items.slice(0, maxEntries).map((it) => it.cid));
  let removed = 0;
  for (const cid of HISTORY_SUMMARY_CACHE.keys()) {
    if (keep.has(cid)) continue;
    HISTORY_SUMMARY_CACHE.delete(cid);
    removed += 1;
  }
  return removed;
}

function setHistorySummaryStorage(storage) {
  historySummaryStorage = storage && typeof storage === "object" ? storage : null;
  HISTORY_SUMMARY_CACHE.clear();
  historySummaryCacheLoaded = false;
  return Boolean(historySummaryStorage);
}

function resolveHistorySummaryStorage() {
  const s = historySummaryStorage && typeof historySummaryStorage === "object" ? historySummaryStorage : null;
  return s;
}

function maybeLoadHistorySummaryCacheFromStorage() {
  if (historySummaryCacheLoaded) return true;
  const storage = resolveHistorySummaryStorage();
  if (!storage || typeof storage.get !== "function") return false;

  try {
    const raw = storage.get(HISTORY_SUMMARY_CACHE_KEY);
    const root = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
    const entries =
      (root && root.entries && typeof root.entries === "object" && !Array.isArray(root.entries) ? root.entries : null) ||
      (root && typeof root === "object" ? root : null) ||
      null;
    if (entries) {
      for (const [cid, v] of Object.entries(entries)) {
        const convId = normalizeString(cid);
        const rec = v && typeof v === "object" && !Array.isArray(v) ? v : null;
        if (!convId || !rec) continue;
        const summaryText = asString(rec.summaryText ?? rec.summary_text);
        const summarizedUntilRequestId = asString(rec.summarizedUntilRequestId ?? rec.summarized_until_request_id);
        const summarizationRequestId = asString(rec.summarizationRequestId ?? rec.summarization_request_id);
        const updatedAtMs = Number(rec.updatedAtMs ?? rec.updated_at_ms) || 0;
        const startRequestId = asString(rec.startRequestId ?? rec.start_request_id);
        const summarizedUntilIndex = Number(rec.summarizedUntilIndex ?? rec.summarized_until_index) || 0;
        const summarizedRequestIdsHash = asString(rec.summarizedRequestIdsHash ?? rec.summarized_request_ids_hash);
        const summarizedTailRequestIds = Array.isArray(rec.summarizedTailRequestIds ?? rec.summarized_tail_request_ids)
          ? rec.summarizedTailRequestIds ?? rec.summarized_tail_request_ids
          : [];
        const summarizedTailHeadRequestIds = Array.isArray(rec.summarizedTailHeadRequestIds ?? rec.summarized_tail_head_request_ids)
          ? rec.summarizedTailHeadRequestIds ?? rec.summarized_tail_head_request_ids
          : [];
        if (!summarizedUntilRequestId) continue;
        HISTORY_SUMMARY_CACHE.set(convId, {
          summaryText,
          summarizedUntilRequestId,
          summarizationRequestId,
          updatedAtMs,
          startRequestId,
          summarizedUntilIndex,
          summarizedRequestIdsHash,
          summarizedTailRequestIds,
          summarizedTailHeadRequestIds
        });
      }
    }
    historySummaryCacheLoaded = true;
    const removed = pruneHistorySummaryCache();
    if (removed) {
      debug(`historySummary cache pruned: removed=${removed} kept=${HISTORY_SUMMARY_CACHE.size} (max=${HISTORY_SUMMARY_CACHE_MAX_ENTRIES})`);
      if (typeof storage.update === "function") {
        persistHistorySummaryCacheToStorage().catch(() => void 0);
      }
    }
    debug(`historySummary cache loaded: entries=${HISTORY_SUMMARY_CACHE.size}`);
    return true;
  } catch (err) {
    debug(`historySummary cache load failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function persistHistorySummaryCacheToStorage() {
  const storage = resolveHistorySummaryStorage();
  if (!storage || typeof storage.update !== "function") return false;

  pruneHistorySummaryCache();

  const entries = {};
  for (const [cid, v] of HISTORY_SUMMARY_CACHE.entries()) {
    entries[cid] = {
      summaryText: asString(v?.summaryText),
      summarizedUntilRequestId: asString(v?.summarizedUntilRequestId),
      summarizationRequestId: asString(v?.summarizationRequestId),
      updatedAtMs: Number(v?.updatedAtMs) || 0,
      startRequestId: asString(v?.startRequestId),
      summarizedUntilIndex: Number(v?.summarizedUntilIndex) || 0,
      summarizedRequestIdsHash: asString(v?.summarizedRequestIdsHash),
      summarizedTailRequestIds: Array.isArray(v?.summarizedTailRequestIds) ? v.summarizedTailRequestIds : [],
      summarizedTailHeadRequestIds: Array.isArray(v?.summarizedTailHeadRequestIds) ? v.summarizedTailHeadRequestIds : []
    };
  }
  try {
    await storage.update(HISTORY_SUMMARY_CACHE_KEY, { version: 1, entries });
    return true;
  } catch (err) {
    debug(`historySummary cache persist failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function cacheGetFresh(conversationId, boundaryRequestId, now, ttlMs, opts) {
  maybeLoadHistorySummaryCacheFromStorage();
  const cid = normalizeString(conversationId);
  const bid = normalizeString(boundaryRequestId);
  if (!cid || !bid) return null;
  const e = HISTORY_SUMMARY_CACHE.get(cid);
  if (!e) return null;
  if (ttlMs > 0 && now - Number(e.updatedAtMs || 0) > ttlMs) return null;
  if (normalizeString(e.summarizedUntilRequestId) !== bid) return null;

  const o = opts && typeof opts === "object" && !Array.isArray(opts) ? opts : null;
  const history = o && Array.isArray(o.history) ? o.history : null;
  const droppedHead = o && Array.isArray(o.droppedHead) ? o.droppedHead : null;
  if (history && droppedHead) {
    const ok = verifyHistorySummaryCacheEntryForHistory(e, {
      history,
      boundaryId: bid,
      boundaryIdx: droppedHead.length,
      droppedHead
    });
    if (!ok) return null;
  }

  return { summaryText: asString(e.summaryText), summarizationRequestId: asString(e.summarizationRequestId) };
}

function cacheGetFreshState(conversationId, now, ttlMs, opts) {
  maybeLoadHistorySummaryCacheFromStorage();
  const cid = normalizeString(conversationId);
  if (!cid) return null;
  const e = HISTORY_SUMMARY_CACHE.get(cid);
  if (!e) return null;
  if (ttlMs > 0 && now - Number(e.updatedAtMs || 0) > ttlMs) return null;

  const o = opts && typeof opts === "object" && !Array.isArray(opts) ? opts : null;
  const history = o && Array.isArray(o.history) ? o.history : null;
  if (history) {
    const boundaryId = normalizeString(e.summarizedUntilRequestId);
    const boundaryIdx = boundaryId ? history.findIndex((h) => exchangeRequestId(h) === boundaryId) : -1;
    const ok = verifyHistorySummaryCacheEntryForHistory(e, { history, boundaryId, boundaryIdx });
    if (!ok) return null;
  }

  return { ...e };
}

function verifyHistorySummaryCacheEntryForHistory(entry, { history, boundaryId, boundaryIdx, droppedHead } = {}) {
  const e = entry && typeof entry === "object" ? entry : {};
  const hs = Array.isArray(history) ? history : null;
  if (!hs || !hs.length) return true;

  const storedStart = normalizeString(e.startRequestId);
  const storedIndex = Number(e.summarizedUntilIndex);
  const storedHash = normalizeString(e.summarizedRequestIdsHash);
  const storedTailIds = Array.isArray(e.summarizedTailRequestIds) ? e.summarizedTailRequestIds : [];
  const storedTailHeadIds = Array.isArray(e.summarizedTailHeadRequestIds) ? e.summarizedTailHeadRequestIds : [];

  if (!storedStart || !storedHash || !Number.isFinite(storedIndex)) return false;

  const currentStart = historyStartRequestId(hs);
  const idx = Number.isFinite(Number(boundaryIdx)) ? Math.floor(Number(boundaryIdx)) : -1;
  const bid = normalizeString(boundaryId);
  const head = Array.isArray(droppedHead) ? droppedHead : idx > 0 ? hs.slice(0, idx) : [];

  // start 相同但 boundary 缺失：通常是“回退/分叉”导致历史变短，缓存 summary 很可能包含了已不存在的 turns。
  if (storedStart && currentStart && storedStart === currentStart && bid && idx < 0) return false;

  if (storedStart && currentStart && storedStart === currentStart) {
    if (idx !== storedIndex) return false;
    if (computeRequestIdsHash(head) !== storedHash) return false;
    return true;
  }

  if (idx >= 0) {
    // history 头部被裁剪：用 droppedHead 的尾部 request_id 做强校验，避免把旧 summary 注入到不相关的 thread/分叉上。
    const currentTailIds = tailRequestIds(head, DEFAULT_SUMMARY_TAIL_REQUEST_IDS);
    return tailIdsEndsWith(storedTailIds, currentTailIds);
  }

  // boundary 不存在且 start 不同：通常是历史被进一步裁剪到 boundary 之后。
  // 为避免把旧 summary 注入到分叉/不相关的 thread 上，仅当当前 start 出现在缓存记录的 tail 头部 id 列表中时才接受（说明仍在同一条对话尾部范围内）。
  if (currentStart && storedTailHeadIds.length) {
    return storedTailHeadIds.some((id) => normalizeString(id) === currentStart);
  }
  return false;
}

async function cachePut(conversationId, boundaryRequestId, summaryText, summarizationRequestId, now, meta) {
  maybeLoadHistorySummaryCacheFromStorage();
  const cid = normalizeString(conversationId);
  const bid = normalizeString(boundaryRequestId);
  if (!cid || !bid) return;
  const m = meta && typeof meta === "object" ? meta : {};
  const startRequestId = normalizeString(m.startRequestId);
  const summarizedUntilIndex = Number.isFinite(Number(m.summarizedUntilIndex)) ? Math.max(0, Math.floor(Number(m.summarizedUntilIndex))) : 0;
  const summarizedRequestIdsHash = normalizeString(m.summarizedRequestIdsHash);
  const summarizedTailRequestIds = Array.isArray(m.summarizedTailRequestIds) ? m.summarizedTailRequestIds : [];
  const summarizedTailHeadRequestIds = Array.isArray(m.summarizedTailHeadRequestIds) ? m.summarizedTailHeadRequestIds : [];
  HISTORY_SUMMARY_CACHE.set(cid, {
    summaryText: asString(summaryText),
    summarizedUntilRequestId: bid,
    summarizationRequestId: asString(summarizationRequestId),
    updatedAtMs: Number(now) || nowMs(),
    startRequestId,
    summarizedUntilIndex,
    summarizedRequestIdsHash,
    summarizedTailRequestIds,
    summarizedTailHeadRequestIds
  });
  await persistHistorySummaryCacheToStorage();
}

async function deleteHistorySummaryCache(conversationId) {
  maybeLoadHistorySummaryCacheFromStorage();
  const cid = normalizeString(conversationId);
  if (!cid) return false;
  const existed = HISTORY_SUMMARY_CACHE.delete(cid);
  if (!existed) return false;
  await persistHistorySummaryCacheToStorage();
  return true;
}

async function clearHistorySummaryCacheAll() {
  maybeLoadHistorySummaryCacheFromStorage();
  const n = HISTORY_SUMMARY_CACHE.size;
  if (!n) return 0;
  HISTORY_SUMMARY_CACHE.clear();
  await persistHistorySummaryCacheToStorage();
  return n;
}

module.exports = {
  setHistorySummaryStorage,
  cacheGetFresh,
  cacheGetFreshState,
  cachePut,
  deleteHistorySummaryCache,
  clearHistorySummaryCacheAll
};
