"use strict";

const { normalizeString } = require("../../infra/util");

const BUILTIN_CONTEXT_WINDOW_TOKENS_OVERRIDES = Object.freeze({
  "gpt-5.3-codex": 400000,
  "gpt-5-max": 400000,
  "gpt-5.3": 400000,
  "gpt-5.2": 400000,
  "gpt-5.1": 400000,
  "gpt-5": 400000,

  "claude-4.6-opus": 1000000,
  "claude-4.6-sonnet": 200000,
  "claude-4.5-opus": 1000000,
  "claude-4.5-sonnet": 200000,
  "claude-4.0-opus": 1000000,
  "claude-4.0-sonnet": 200000,
  "claude-opus": 1000000,
  "claude-sonnet": 200000,
  "claude-4": 200000,

  "gemini-3-pro": 1000000,
  "gemini-3-flash": 1000000,
  "gemini-2.5-pro": 1000000,
  "gemini-2.5-flash": 1000000,
  "gemini-pro": 1000000,
  "gemini-flash": 1000000,

  "kimi-k2": 128000,
  kimi: 128000
});

const BUILTIN_CONTEXT_WINDOW_TOKENS_OVERRIDE_KEYS = Object.freeze(
  Object.keys(BUILTIN_CONTEXT_WINDOW_TOKENS_OVERRIDES).sort((a, b) => String(b).length - String(a).length)
);

function inferContextWindowTokensFromModelName(model) {
  const m = normalizeString(model).toLowerCase();
  if (!m) return null;

  for (const key of BUILTIN_CONTEXT_WINDOW_TOKENS_OVERRIDE_KEYS) {
    if (m.includes(key)) {
      const v = Number(BUILTIN_CONTEXT_WINDOW_TOKENS_OVERRIDES[key]);
      if (Number.isFinite(v) && v > 0) return Math.floor(v);
    }
  }
  return null;
}

module.exports = { inferContextWindowTokensFromModelName, BUILTIN_CONTEXT_WINDOW_TOKENS_OVERRIDES };
