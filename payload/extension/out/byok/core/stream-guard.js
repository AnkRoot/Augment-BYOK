"use strict";

const { warn } = require("../infra/log");
const { normalizeString, safeTransform } = require("../infra/util");

function isTransformFailure(err) {
  const m = err instanceof Error ? err.message : "";
  return typeof m === "string" && m.startsWith("transform failed");
}

function makeEndpointErrorText(ep, err) {
  const label = normalizeString(ep) || "endpoint";
  const msg = err instanceof Error ? err.message : String(err);
  const m = normalizeString(msg) || "unknown error";
  return `❌ ${label} 失败: ${m}`.trim();
}

async function* guardObjectStream({ ep, src, transform, makeErrorChunk }) {
  try {
    for await (const raw of src) {
      const transformed = safeTransform(transform, raw, ep);
      yield transformed;
    }
  } catch (err) {
    if (isTransformFailure(err)) throw err;
    warn(makeEndpointErrorText(ep, err));
    const fallback = typeof makeErrorChunk === "function" ? makeErrorChunk(err) : null;
    if (fallback != null) yield safeTransform(transform, fallback, ep);
  }
}

module.exports = { makeEndpointErrorText, guardObjectStream };
