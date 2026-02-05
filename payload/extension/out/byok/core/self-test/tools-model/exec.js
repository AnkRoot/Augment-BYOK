"use strict";

const path = require("path");

const { debug } = require("../../../infra/log");
const { nowMs } = require("../../../infra/trace");
const { normalizeString, randomId } = require("../../../infra/util");

const { dedupeToolDefsByName } = require("../tool-defs");

const { getToolsModelFromUpstreamOrNull, isToolsModelCandidate } = require("./globals");
const { toolsModelCallTool } = require("./exec-call-tool");
const { normalizeFsPath, ensureDir, rmPathRecursive } = require("./exec-fs");
const { runFsToolSmokeTests } = require("./exec-steps-fs");
const { runTerminalToolSmokeTests } = require("./exec-steps-terminal");
const { runMiscToolSmokeTests } = require("./exec-steps-misc");

async function selfTestToolsModelExec({ toolDefinitions, timeoutMs, abortSignal, log } = {}) {
  const emit = (line) => {
    try {
      if (typeof log === "function") log(String(line || ""));
    } catch {}
  };

  const defs = dedupeToolDefsByName(toolDefinitions);
  const byName = new Map(defs.map((d) => [normalizeString(d?.name), d]).filter((x) => x[0]));
  const toolNames = Array.from(byName.keys()).sort((a, b) => a.localeCompare(b));
  if (!toolNames.length) return { ok: false, ms: 0, detail: "no tools" };

  const toolsModel = getToolsModelFromUpstreamOrNull();
  if (!isToolsModelCandidate(toolsModel)) return { ok: false, ms: 0, detail: "toolsModel not available (need patched upstream)" };

  // workspace root（view/save-file/diagnostics 等都要求 workspace 相对路径）
  let workspaceRoot = "";
  try {
    const vscode = require("vscode");
    const wf = Array.isArray(vscode?.workspace?.workspaceFolders) ? vscode.workspace.workspaceFolders : [];
    workspaceRoot = normalizeString(wf?.[0]?.uri?.fsPath);
  } catch {}
  if (!workspaceRoot) return { ok: false, ms: 0, detail: "no workspace folder (tools require workspace-relative paths)" };

  const runId = randomId();
  const scratchRelDir = normalizeFsPath(path.posix.join("BYOK-test", `run-${runId}`));
  const scratchAbsDir = path.join(workspaceRoot, scratchRelDir);
  const fileRel = normalizeFsPath(path.posix.join(scratchRelDir, "tool_test.txt"));
  const fileAbs = path.join(workspaceRoot, fileRel);
  const bigRel = normalizeFsPath(path.posix.join(scratchRelDir, "big.txt"));
  const bigAbs = path.join(workspaceRoot, bigRel);
  const diagRel = normalizeFsPath(path.posix.join(scratchRelDir, "diag_test.js"));
  const diagAbs = path.join(workspaceRoot, diagRel);

  // toolsModel.callTool 的 conversationId 主要用于 tasklist / rules / telemetry 等“会话绑定”工具。
  // Self Test 不应污染用户真实会话，因此固定使用专用 conversationId。
  const conversationId = "byok-selftest-toolsexec";

  const results = new Map(); // toolName -> {ok, detail}
  const mark = (name, ok, detail) => {
    if (!name) return;
    const nextOk = Boolean(ok);
    const prev = results.get(name);
    // “覆盖”语义：只要有一次成功就算该工具可用；失败只在尚无成功时才记录。
    if (prev && prev.ok === true && nextOk === false) return;
    results.set(name, { ok: nextOk, detail: normalizeString(detail) || "" });
  };

  // 部分工具在某些环境中会“稳定失败”但不应判定为 BYOK 协议问题：
  // - Agents API（/agents/* 或 /relay/agents/*）相关工具：在 completion_url 未实现 Agents 路由时会失败（例如 web-search）。
  // - open-browser：在无 GUI / 宿主策略禁止打开浏览器时会失败。
  // 规则：这些工具允许失败；其余工具必须严格通过。
  const OPTIONAL_TOOL_NAMES = new Set(["web-search", "open-browser"]);

  const isAgentsRoutedFailure = (detail) => {
    const s = normalizeString(detail).toLowerCase();
    if (!s) return false;
    // run-remote-tool 是 remoteToolHost 的执行入口；codebase-retrieval 也属于 agents tools。
    return (
      s.includes("augment agents") ||
      s.includes("/agents/*") ||
      s.includes("agents/run-remote-tool") ||
      s.includes("agents/codebase-retrieval") ||
      s.includes("agents/list-remote-tools") ||
      s.includes("agents/revoke-tool-access") ||
      s.includes("agents/edit-file") ||
      s.includes("/relay/agents/")
    );
  };

  const isOptionalToolFailure = (toolName, detail) => {
    const name = normalizeString(toolName);
    if (!name) return false;
    if (OPTIONAL_TOOL_NAMES.has(name)) return true;
    return isAgentsRoutedFailure(detail);
  };

  const callIfPresent = async (name, input) => {
    if (!byName.has(name)) return { ok: true, skipped: true, detail: "tool not in captured list" };
    emit(`[toolsExec] calling ${name} ...`);
    const r = await toolsModelCallTool({ toolsModel, toolName: name, input, conversationId, log, abortSignal });
    mark(name, r.ok, r.detail);
    return r;
  };

  const t0 = nowMs();
  debug(`[self-test][toolsExec] start tools=${toolNames.length}`);
  emit(`[toolsExec] start tools=${toolNames.length} workspace=${normalizeFsPath(workspaceRoot)} scratch=${scratchRelDir} conversationId=${conversationId}`);

  try {
    await ensureDir(scratchAbsDir);

    await runFsToolSmokeTests({ byName, callIfPresent, emit, scratchRelDir, fileRel, fileAbs });
    await runTerminalToolSmokeTests({ byName, callIfPresent, emit, workspaceRoot, bigRel, bigAbs });
    await runMiscToolSmokeTests({ byName, callIfPresent, emit, toolsModel, conversationId, diagRel, diagAbs });
  } finally {
    // 清理：尽量删除 scratch；如果用户想保留，可以手动取消或自行复制。
    try {
      await rmPathRecursive(scratchAbsDir);
    } catch {}
  }

  // 覆盖检查：确保 toolNames 都至少记录了一次（否则属于“没有走到该工具”）
  const missing = toolNames.filter((n) => !results.has(n));
  for (const n of missing) results.set(n, { ok: false, detail: "not executed" });

  const failed = Array.from(results.entries()).filter(([, v]) => v && v.ok === false);
  const failedOptional = failed.filter(([name, v]) => isOptionalToolFailure(name, v?.detail));
  const failedRequired = failed.filter(([name, v]) => !isOptionalToolFailure(name, v?.detail));
  const failedNames = failedRequired.map(([name]) => name).filter(Boolean);
  const failedOptionalNames = failedOptional.map(([name]) => name).filter(Boolean);
  const ok = failedRequired.length === 0;
  const ms = nowMs() - t0;
  debug(
    `[self-test][toolsExec] done ok=${String(ok)} failed_required=${failedRequired.length} failed_optional=${failedOptional.length} ms=${ms}`
  );
  const failedPreview = failedNames.slice(0, 8).join(",");
  const optionalFailedPreview = failedOptionalNames.slice(0, 8).join(",");
  const detail =
    `tools=${toolNames.length} executed=${results.size} failed=${failedRequired.length}` +
    (failedRequired.length ? ` first=${failedRequired[0][0]}` : "") +
    (failedNames.length ? ` failed_tools=${failedPreview}${failedNames.length > 8 ? ",…" : ""}` : "");
  const detailWithOptional =
    detail +
    (failedOptional.length
      ? ` optional_failed=${failedOptional.length}` +
        (failedOptionalNames.length ? ` optional_failed_tools=${optionalFailedPreview}${failedOptionalNames.length > 8 ? ",…" : ""}` : "")
      : "");
  emit(`[toolsExec] done ok=${String(ok)} ${detailWithOptional}`);

  const toolResults = {};
  for (const [name, r] of results.entries()) toolResults[name] = r;
  return {
    ok,
    ms,
    detail: detailWithOptional,
    failedTools: failedNames.slice(0, 12),
    failedToolsTruncated: failedNames.length > 12,
    optionalFailedTools: failedOptionalNames.slice(0, 12),
    optionalFailedToolsTruncated: failedOptionalNames.length > 12,
    toolResults
  };
}

module.exports = { selfTestToolsModelExec };
