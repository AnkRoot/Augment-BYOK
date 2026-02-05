#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const { ensureMarker, replaceOnceRegex } = require("../lib/patch");

const MARKER = "__augment_byok_memories_upper_bound_size_patched_v1";

function patchMemoriesUpperBoundSize(filePath, { defaultUpperBoundSize = 10000 } = {}) {
  if (!fs.existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
  const original = fs.readFileSync(filePath, "utf8");
  if (original.includes(MARKER)) return { changed: false, reason: "already_patched" };

  const upper = Number.isFinite(Number(defaultUpperBoundSize)) && Number(defaultUpperBoundSize) > 0 ? Math.floor(Number(defaultUpperBoundSize)) : 10000;

  // remember tool: injectMemories -> _setMemories() reads feature flag `flags.memoriesParams.upper_bound_size`.
  // In BYOK / proxy env, flags can be missing, causing remember() to fail with:
  //   "Failed to save memories: upper bound size missing"
  //
  // Patch: add a safe default upper_bound_size if missing.
  const re = /let\s+([A-Za-z_$][0-9A-Za-z_$]*)=([A-Za-z_$][0-9A-Za-z_$]*)\(\)\.flags\.memoriesParams\.upper_bound_size;/g;

  let next = replaceOnceRegex(
    original,
    re,
    (m) => {
      const varName = m && m[1] ? String(m[1]) : "";
      const fnName = m && m[2] ? String(m[2]) : "";
      if (!varName || !fnName) throw new Error("patch failed: missing capture groups");
      return `let __byok_memoriesParams=${fnName}().flags.memoriesParams;let ${varName}=(__byok_memoriesParams&&__byok_memoriesParams.upper_bound_size)||${String(upper)};`;
    },
    "memories upper_bound_size default"
  );

  next = ensureMarker(next, MARKER);
  fs.writeFileSync(filePath, next, "utf8");
  return { changed: true, reason: "patched", defaultUpperBoundSize: upper };
}

module.exports = { patchMemoriesUpperBoundSize };

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error(`usage: ${path.basename(process.argv[1])} <extension/out/extension.js>`);
    process.exit(2);
  }
  patchMemoriesUpperBoundSize(filePath);
}
