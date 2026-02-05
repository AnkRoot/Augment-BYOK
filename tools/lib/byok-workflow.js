"use strict";

const fs = require("fs");
const path = require("path");

const { copyDir } = require("./fs");
const { run } = require("./run");

const { patchAugmentInterceptorInject } = require("../patch/patch-augment-interceptor-inject");
const { patchDisableChatHistoryTruncation } = require("../patch/patch-disable-chat-history-truncation");
const { patchExtensionEntry } = require("../patch/patch-extension-entry");
const { patchOfficialOverrides } = require("../patch/patch-official-overrides");
const { patchCallApiShim } = require("../patch/patch-callapi-shim");
const { patchExposeUpstream } = require("../patch/patch-expose-upstream");
const { patchModelPickerByokOnly } = require("../patch/patch-model-picker-byok-only");
const { patchMemoriesUpperBoundSize } = require("../patch/patch-memories-upper-bound-size");
const { patchTasklistAutoRoot } = require("../patch/patch-tasklist-auto-root");
const { patchTasklistAddTasksSanitizeEmptyIds } = require("../patch/patch-tasklist-add-tasks-sanitize-empty-ids");
const { patchTasklistAddTasksErrors } = require("../patch/patch-tasklist-add-tasks-errors");
const { patchPackageJsonCommands } = require("../patch/patch-package-json-commands");
const { patchWebviewToolUseFallback } = require("../patch/patch-webview-tooluse-fallback");
const { patchWebviewHistorySummaryNode } = require("../patch/patch-webview-history-summary-node");
const { guardNoAutoAuth } = require("../patch/guard-no-autoauth");

function makeLogger(prefix) {
  const p = String(prefix || "").trim();
  if (!p) return () => void 0;
  return (msg) => console.log(`[${p}] ${msg}`);
}

function applyByokPatches({ repoRoot, extensionDir, pkgPath, extJsPath, interceptorInjectPath, logPrefix }) {
  const log = makeLogger(logPrefix || "byok");
  const root = path.resolve(String(repoRoot || ""));
  const extDir = path.resolve(String(extensionDir || ""));
  const pkg = path.resolve(String(pkgPath || ""));
  const extJs = path.resolve(String(extJsPath || ""));
  const injectPath = path.resolve(String(interceptorInjectPath || ""));

  const rel = (p) => path.relative(root, p).replace(/\\/g, "/");

  if (!root || root === path.parse(root).root) throw new Error("applyByokPatches: invalid repoRoot");
  if (!extDir || extDir === path.parse(extDir).root) throw new Error("applyByokPatches: invalid extensionDir");
  if (!fs.existsSync(pkg)) throw new Error(`applyByokPatches: package.json missing: ${rel(pkg)}`);
  if (!fs.existsSync(extJs)) throw new Error(`applyByokPatches: out/extension.js missing: ${rel(extJs)}`);
  if (!fs.existsSync(injectPath)) throw new Error(`applyByokPatches: injector missing: ${rel(injectPath)}`);

  log(`overlay payload (extension/out/byok/*)`);
  const payloadDir = path.join(root, "payload", "extension");
  if (!fs.existsSync(payloadDir)) throw new Error(`payload missing: ${rel(payloadDir)}`);
  copyDir(payloadDir, extDir);

  log(`patch webview assets (tool cards fallback)`);
  patchWebviewToolUseFallback(extDir);

  log(`patch webview assets (history summary node slimming)`);
  patchWebviewHistorySummaryNode(extDir);

  log(`patch package.json (commands)`);
  patchPackageJsonCommands(pkg);

  log(`inject augment interceptor`);
  patchAugmentInterceptorInject(extJs, { injectPath });

  log(`patch entry bootstrap`);
  patchExtensionEntry(extJs);

  log(`disable upstream chat history truncation when BYOK enabled`);
  patchDisableChatHistoryTruncation(extJs);

  log(`expose upstream internals (toolsModel)`);
  patchExposeUpstream(extJs);

  log(`patch official (completionURL/apiToken from globalState config)`);
  patchOfficialOverrides(extJs);

  log(`patch callApi/callApiStream shim`);
  patchCallApiShim(extJs);

  log(`patch model picker (BYOK-only models when enabled)`);
  patchModelPickerByokOnly(extJs);

  log(`patch memories (remember tool upper_bound_size fallback)`);
  patchMemoriesUpperBoundSize(extJs);

  log(`patch tasklist tools (auto root task init)`);
  patchTasklistAutoRoot(extJs);

  log(`patch tasklist tools (add_tasks sanitize empty optional IDs)`);
  patchTasklistAddTasksSanitizeEmptyIds(extJs);

  log(`patch tasklist tools (add_tasks error reporting)`);
  patchTasklistAddTasksErrors(extJs);

  log(`guard: no autoAuth`);
  guardNoAutoAuth(extJs);

  log(`sanity check (node --check out/extension.js)`);
  run("node", ["--check", extJs], { cwd: root });
}

function runByokContractChecks({ repoRoot, extensionDir, extJsPath, pkgPath, logPrefix }) {
  const log = makeLogger(logPrefix || "byok");
  const root = path.resolve(String(repoRoot || ""));
  const extDir = path.resolve(String(extensionDir || ""));
  const extJs = path.resolve(String(extJsPath || ""));
  const pkg = path.resolve(String(pkgPath || ""));

  if (!root || root === path.parse(root).root) throw new Error("runByokContractChecks: invalid repoRoot");
  if (!extDir || extDir === path.parse(extDir).root) throw new Error("runByokContractChecks: invalid extensionDir");
  if (!fs.existsSync(pkg)) throw new Error(`runByokContractChecks: package.json missing: ${path.relative(root, pkg)}`);
  if (!fs.existsSync(extJs)) throw new Error(`runByokContractChecks: out/extension.js missing: ${path.relative(root, extJs)}`);

  log(`contract checks`);
  run(
    "node",
    [
      path.join(root, "tools", "check", "byok-contracts", "main.js"),
      "--extensionDir",
      extDir,
      "--extJs",
      extJs,
      "--pkg",
      pkg
    ],
    { cwd: root }
  );
}

module.exports = { applyByokPatches, runByokContractChecks };
