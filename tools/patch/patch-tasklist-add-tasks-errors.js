#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const { ensureMarker, replaceOnceRegex } = require("../lib/patch");

const MARKER = "__augment_byok_tasklist_add_tasks_errors_patched_v1";

function patchTasklistAddTasksErrors(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
  const original = fs.readFileSync(filePath, "utf8");
  if (original.includes(MARKER)) return { changed: false, reason: "already_patched" };

  let next = original;

  // Upstream add_tasks swallows per-task creation errors inside handleBatchCreation and returns
  // "Created: 0, Updated: 0, Deleted: 0" with no error details.
  // Patch: if any tasks fail, append failure summary; if all fail, return isError=true with details.
  next = replaceOnceRegex(
    next,
    /async handleBatchCreation\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{[\s\S]*?let\s+([A-Za-z_$][\w$]*)=\[\];for\(let[\s\S]*?let\s+([A-Za-z_$][\w$]*)=V0\.formatBulkUpdateResponse\(Qk\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\);return\{\.\.\.xr\(\4\),plan:\6\}\}/g,
    (m) => {
      const resultsVar = String(m[3] || "");
      const textVar = String(m[4] || "");
      const beforeVar = String(m[5] || "");
      const afterVar = String(m[6] || "");
      if (!resultsVar || !textVar || !beforeVar || !afterVar) throw new Error("tasklist add_tasks errors: capture missing");

      const oldTail = `let ${textVar}=V0.formatBulkUpdateResponse(Qk(${beforeVar},${afterVar}));return{...xr(${textVar}),plan:${afterVar}}`;
      const insertion =
        `let __byok_failed=${resultsVar}.filter(t=>t&&t.success===!1);` +
        `if(__byok_failed.length){` +
        `let __byok_lines=__byok_failed.slice(0,10).map(t=>"- "+String(t.taskName)+": "+String(t.error||"unknown")).join("\\n");` +
        `let __byok_more=__byok_failed.length>10?"\\n… ("+String(__byok_failed.length-10)+" more)":"";
` +
        `let __byok_msg="\\n\\nTask creation failures ("+String(__byok_failed.length)+"/"+String(${resultsVar}.length)+"):\\n"+__byok_lines+__byok_more;` +
        `if(__byok_failed.length===${resultsVar}.length)return{...it("Failed to add task(s)."+__byok_msg),plan:${afterVar}};` +
        `${textVar}+=__byok_msg;` +
        `}`;

      const newTail = `let ${textVar}=V0.formatBulkUpdateResponse(Qk(${beforeVar},${afterVar}));${insertion}return{...xr(${textVar}),plan:${afterVar}}`;
      if (!m[0].includes(oldTail)) throw new Error("tasklist add_tasks errors: tail not found (upstream may have changed)");
      return m[0].replace(oldTail, newTail);
    },
    "tasklist add_tasks errors: handleBatchCreation"
  );

  next = ensureMarker(next, MARKER);
  fs.writeFileSync(filePath, next, "utf8");
  return { changed: true, reason: "patched" };
}

module.exports = { patchTasklistAddTasksErrors };

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error(`usage: ${path.basename(process.argv[1])} <extension/out/extension.js>`);
    process.exit(2);
  }
  patchTasklistAddTasksErrors(filePath);
}
