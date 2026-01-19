"use strict";

const { normalizeString } = require("../infra/util");
const { debug } = require("../infra/log");
const { createAbortError, safeFetch } = require("./http");

const DEFAULT_RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function isAbortError(err) {
  return Boolean(err && typeof err === "object" && err.name === "AbortError");
}

function isTimeoutAbortError(err) {
  if (!isAbortError(err)) return false;
  const msg = err instanceof Error ? err.message : "";
  return /\btimeout\b/i.test(String(msg || ""));
}

function parseRetryAfterMs(resp) {
  const raw = normalizeString(resp?.headers?.get?.("retry-after"));
  if (!raw) return null;

  // seconds (most common)
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  // HTTP-date
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) {
    const delta = at - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

function computeBackoffMs(retryIndex, { baseDelayMs, maxDelayMs } = {}) {
  const base = Number.isFinite(Number(baseDelayMs)) && Number(baseDelayMs) >= 0 ? Number(baseDelayMs) : 250;
  const cap = Number.isFinite(Number(maxDelayMs)) && Number(maxDelayMs) > 0 ? Number(maxDelayMs) : 4000;
  const exp = Math.min(cap, base * 2 ** Math.max(0, Math.floor(retryIndex)));
  const jitter = exp * (0.2 * Math.random()); // 0~20%
  return Math.max(0, Math.round(exp + jitter));
}

async function sleepMs(ms, abortSignal) {
  const delay = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Math.floor(Number(ms)) : 0;
  if (!delay) return;

  if (abortSignal && abortSignal.aborted) throw createAbortError("Aborted");
  await new Promise((resolve, reject) => {
    const hasSignal = abortSignal && typeof abortSignal.addEventListener === "function";
    const onAbort = () => {
      clearTimeout(timer);
      if (hasSignal) {
        try { abortSignal.removeEventListener("abort", onAbort); } catch {}
      }
      reject(createAbortError("Aborted"));
    };

    const timer = setTimeout(() => {
      if (hasSignal) {
        try { abortSignal.removeEventListener("abort", onAbort); } catch {}
      }
      resolve();
    }, delay);

    if (hasSignal) abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

function tryParseJson(text) {
  const s = normalizeString(text);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractErrorMessageFromJson(json) {
  const obj = json && typeof json === "object" ? json : null;
  if (!obj) return "";

  // OpenAI: { error: { message, type, code, ... } }
  // Anthropic: { type: "error", error: { type, message } }
  // Gemini: { error: { message, status, code } }
  const errObj = obj.error && typeof obj.error === "object" ? obj.error : null;
  if (typeof obj.error === "string" && obj.error.trim()) return obj.error.trim();

  const msg =
    normalizeString(errObj?.message) ||
    normalizeString(obj.message) ||
    normalizeString(obj.error?.message) ||
    "";
  const type = normalizeString(errObj?.type) || normalizeString(errObj?.status) || normalizeString(obj.type) || "";
  const code = normalizeString(errObj?.code) || "";

  if (type && msg) return code ? `${type}/${code}: ${msg}` : `${type}: ${msg}`;
  if (msg) return msg;

  const detail = normalizeString(errObj?.error?.message) || normalizeString(obj.detail) || "";
  if (detail) return detail;
  return "";
}

function getRequestId(resp) {
  if (!resp || !resp.headers || typeof resp.headers.get !== "function") return "";
  return normalizeString(
    resp.headers.get("x-request-id") ||
      resp.headers.get("request-id") ||
      resp.headers.get("x-amzn-requestid") ||
      resp.headers.get("x-amz-request-id")
  );
}

async function readErrorBodyText(resp) {
  return await resp.text().catch(() => "");
}

function previewText(raw, maxChars) {
  const lim = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Number(maxChars) : 500;
  const s = typeof raw === "string" ? raw : String(raw ?? "");
  return s.length > lim ? s.slice(0, lim) + "…" : s;
}

async function readHttpErrorDetail(resp, { maxChars } = {}) {
  const raw = await readErrorBodyText(resp);
  const json = tryParseJson(raw);
  const structured = extractErrorMessageFromJson(json);
  const preview = previewText(raw, maxChars);
  const detail = normalizeString(structured) || normalizeString(preview) || "<empty body>";
  const requestId = getRequestId(resp);
  return requestId ? `${detail} (request_id=${requestId})` : detail;
}

async function makeUpstreamHttpError(resp, { label, maxChars } = {}) {
  const lab = normalizeString(label) || "HTTP";
  const detail = await readHttpErrorDetail(resp, { maxChars });
  const err = new Error(`${lab} ${resp?.status ?? ""}: ${detail}`.trim());
  err.name = "UpstreamHttpError";
  if (resp && typeof resp === "object" && Number.isFinite(Number(resp.status))) err.status = resp.status;
  return err;
}

async function fetchWithRetry(url, init, { timeoutMs, abortSignal, label, maxAttempts, retryableStatuses, baseDelayMs, maxDelayMs } = {}) {
  const attempts = Number.isFinite(Number(maxAttempts)) && Number(maxAttempts) > 0 ? Math.floor(Number(maxAttempts)) : 3;
  const retryStatuses = retryableStatuses instanceof Set ? retryableStatuses : DEFAULT_RETRYABLE_HTTP_STATUSES;
  const lab = normalizeString(label) || "fetch";

  for (let attempt = 0; attempt < attempts; attempt++) {
    const attemptNo = attempt + 1;
    try {
      const resp = await safeFetch(url, init, { timeoutMs, abortSignal, label: lab });
      if (resp.ok) return resp;

      const canRetry = retryStatuses.has(resp.status) && attemptNo < attempts;
      if (!canRetry) return resp;

      const retryAfter = parseRetryAfterMs(resp);
      const backoff = computeBackoffMs(attempt, { baseDelayMs, maxDelayMs });
      const waitMs = retryAfter != null ? Math.max(retryAfter, backoff) : backoff;
      debug(`${lab} HTTP ${resp.status}: retrying after ${waitMs}ms (attempt ${attemptNo}/${attempts})`);
      try { await resp.text(); } catch {}
      await sleepMs(waitMs, abortSignal);
      continue;
    } catch (err) {
      // 用户手动取消：不要重试
      if (isAbortError(err) && !isTimeoutAbortError(err)) throw err;
      const canRetry = attemptNo < attempts;
      if (!canRetry) throw err;

      const backoff = computeBackoffMs(attempt, { baseDelayMs, maxDelayMs });
      const msg = err instanceof Error ? err.message : String(err);
      debug(`${lab} failed: ${msg}; retrying after ${backoff}ms (attempt ${attemptNo}/${attempts})`);
      await sleepMs(backoff, abortSignal);
    }
  }

  // should be unreachable
  return await safeFetch(url, init, { timeoutMs, abortSignal, label: lab });
}

async function fetchOkWithRetry(url, init, opts) {
  const resp = await fetchWithRetry(url, init, opts);
  if (resp.ok) return resp;
  throw await makeUpstreamHttpError(resp, opts);
}

module.exports = {
  DEFAULT_RETRYABLE_HTTP_STATUSES,
  fetchWithRetry,
  fetchOkWithRetry,
  extractErrorMessageFromJson,
  makeUpstreamHttpError,
  readHttpErrorDetail
};
