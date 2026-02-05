#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const { ensureMarker, replaceOnceRegex } = require("../lib/patch");

const MARKER = "__augment_byok_tasklist_add_tasks_sanitize_empty_ids_patched_v1";

function patchTasklistAddTasksSanitizeEmptyIds(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
  const original = fs.readFileSync(filePath, "utf8");
  if (original.includes(MARKER)) return { changed: false, reason: "already_patched" };

  let next = original;

  // Upstream validation treats empty-string optional IDs as "provided" and fails the whole task create.
  // Patch: in add_tasks' batch loop, coerce whitespace/empty parent_task_id/after_task_id to "unset"
  // before calling createSingleTaskFromInput.
  next = replaceOnceRegex(
    next,
    /for\(let\s+([A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)\)try\{let\s+([A-Za-z_$][\w$]*)=await\s+this\.createSingleTaskFromInput\(([A-Za-z_$][\w$]*),\1\);/g,
    (m) => {
      const itemVar = String(m[1] || "");
      const tasksVar = String(m[2] || "");
      const resultVar = String(m[3] || "");
      const convVar = String(m[4] || "");
      if (!itemVar || !tasksVar || !resultVar || !convVar) throw new Error("tasklist add_tasks sanitize empty ids: capture missing");

      const sanitize =
        `typeof ${itemVar}.parent_task_id==="string"&&${itemVar}.parent_task_id.trim()===""&&delete ${itemVar}.parent_task_id;` +
        `typeof ${itemVar}.after_task_id==="string"&&${itemVar}.after_task_id.trim()===""&&delete ${itemVar}.after_task_id;`;

      return `for(let ${itemVar} of ${tasksVar})try{${sanitize}let ${resultVar}=await this.createSingleTaskFromInput(${convVar},${itemVar});`;
    },
    "tasklist add_tasks sanitize empty ids: batch loop"
  );

  next = ensureMarker(next, MARKER);
  fs.writeFileSync(filePath, next, "utf8");
  return { changed: true, reason: "patched" };
}

module.exports = { patchTasklistAddTasksSanitizeEmptyIds };

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error(`usage: ${path.basename(process.argv[1])} <extension/out/extension.js>`);
    process.exit(2);
  }
  patchTasklistAddTasksSanitizeEmptyIds(filePath);
}
