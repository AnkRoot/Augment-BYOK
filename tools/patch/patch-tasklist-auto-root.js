#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const { ensureMarker, replaceOnceRegex } = require("../lib/patch");

const MARKER = "__augment_byok_tasklist_auto_root_patched_v1";

function patchTasklistAutoRoot(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
  const original = fs.readFileSync(filePath, "utf8");
  if (original.includes(MARKER)) return { changed: false, reason: "already_patched" };

  let next = original;

  // Tasklist tools require a conversation-scoped root task list uuid.
  // Upstream creates it lazily via webview flows; direct tool calls can see "No root task found."
  // Patch: if root is missing but we have a conversationId, create it on demand.
  const ensureRoot = (rootVar, conversationIdVar) =>
    `let ${rootVar}=this._taskManager.getRootTaskUuid(${conversationIdVar});` +
    `if(!${rootVar}&&${conversationIdVar}&&typeof this._taskManager.createNewTaskList===\"function\"){${rootVar}=await this._taskManager.createNewTaskList(${conversationIdVar});}` +
    `if(!${rootVar})return it(\"No root task found.\");`;

  // 1) view_tasklist
  next = replaceOnceRegex(
    next,
    /async call\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{try\{let\s+([A-Za-z_$][\w$]*)=this\._taskManager\.getRootTaskUuid\(\6\);if\(!\7\)return it\("No root task found\."\);/g,
    (m) => {
      const convVar = String(m[6] || "");
      const rootVar = String(m[7] || "");
      if (!convVar || !rootVar) throw new Error("tasklist auto root: view_tasklist capture missing");
      return m[0].replace(/let\s+[A-Za-z_$][\w$]*=this\._taskManager\.getRootTaskUuid\([A-Za-z_$][\w$]*\);if\(![A-Za-z_$][\w$]*\)return it\("No root task found\."\);/, ensureRoot(rootVar, convVar));
    },
    "tasklist auto root: view_tasklist"
  );

  // 2) update_tasks: handleBatchUpdate
  next = replaceOnceRegex(
    next,
    /async handleBatchUpdate\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{let\s+([A-Za-z_$][\w$]*)=this\._taskManager\.getRootTaskUuid\(\1\);if\(!\3\)return it\("No root task found\."\);/g,
    (m) => {
      const convVar = String(m[1] || "");
      const rootVar = String(m[3] || "");
      if (!convVar || !rootVar) throw new Error("tasklist auto root: update_tasks capture missing");
      return `async handleBatchUpdate(${m[1]},${m[2]}){${ensureRoot(rootVar, convVar)}`;
    },
    "tasklist auto root: update_tasks"
  );

  // 3) add_tasks: handleBatchCreation
  next = replaceOnceRegex(
    next,
    /async handleBatchCreation\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{let\s+([A-Za-z_$][\w$]*)=this\._taskManager\.getRootTaskUuid\(\1\);if\(!\3\)return it\("No root task found\."\);/g,
    (m) => {
      const convVar = String(m[1] || "");
      const rootVar = String(m[3] || "");
      if (!convVar || !rootVar) throw new Error("tasklist auto root: add_tasks capture missing");
      return `async handleBatchCreation(${m[1]},${m[2]}){${ensureRoot(rootVar, convVar)}`;
    },
    "tasklist auto root: add_tasks"
  );

  // 4) reorganize_tasklist
  next = replaceOnceRegex(
    next,
    /let\s+([A-Za-z_$][\w$]*)=r\.markdown;if\(!\1\)return it\("No markdown provided\."\);let\s+([A-Za-z_$][\w$]*)=this\._taskManager\.getRootTaskUuid\(([A-Za-z_$][\w$]*)\);if\(!\2\)return it\("No root task found\."\);/g,
    (m) => {
      const markdownVar = String(m[1] || "");
      const rootVar = String(m[2] || "");
      const convVar = String(m[3] || "");
      if (!markdownVar || !rootVar || !convVar) throw new Error("tasklist auto root: reorganize capture missing");
      return (
        `let ${markdownVar}=r.markdown;if(!${markdownVar})return it(\"No markdown provided.\");` +
        ensureRoot(rootVar, convVar)
      );
    },
    "tasklist auto root: reorganize_tasklist"
  );

  next = ensureMarker(next, MARKER);
  fs.writeFileSync(filePath, next, "utf8");
  return { changed: true, reason: "patched" };
}

module.exports = { patchTasklistAutoRoot };

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error(`usage: ${path.basename(process.argv[1])} <extension/out/extension.js>`);
    process.exit(2);
  }
  patchTasklistAutoRoot(filePath);
}
