"use strict";

function truncateText(value, maxLen) {
  const raw = typeof value === "string" ? value : String(value ?? "");
  const n = Number(maxLen);
  if (!Number.isFinite(n) || n <= 0) return raw;
  if (raw.length <= n) return raw;
  return raw.slice(0, n) + "…";
}

function truncateTextForPrompt(value, maxChars, defaultMaxChars) {
  const text = typeof value === "string" ? value : String(value ?? "");
  const fallbackMax = Number.isFinite(Number(defaultMaxChars)) && Number(defaultMaxChars) > 0 ? Math.floor(Number(defaultMaxChars)) : 2000;
  const max = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : fallbackMax;
  if (!text.trim()) return "";
  return text.length > max ? text.slice(0, max).trimEnd() + "…" : text.trim();
}

module.exports = { truncateText, truncateTextForPrompt };
