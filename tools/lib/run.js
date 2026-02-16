"use strict";

const { spawnSync } = require("child_process");
let cachedPythonSpec = null;

function run(cmd, args, { cwd } = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.error) throw r.error;
  if (typeof r.status === "number" && r.status !== 0) throw new Error(`command failed: ${cmd} ${args.join(" ")}`);
}

function runWithFallback(candidates, args, { cwd } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const baseArgs = Array.isArray(args) ? args : [];
  const notFound = [];

  for (const item of list) {
    const spec = typeof item === "string" ? { cmd: item, argsPrefix: [] } : item;
    const cmd = typeof spec?.cmd === "string" ? spec.cmd : "";
    if (!cmd) continue;

    const argsPrefix = Array.isArray(spec.argsPrefix) ? spec.argsPrefix : [];
    const finalArgs = [...argsPrefix, ...baseArgs];
    const r = spawnSync(cmd, finalArgs, { cwd, stdio: "inherit" });
    if (r.error) {
      if (r.error && r.error.code === "ENOENT") {
        notFound.push(cmd);
        continue;
      }
      throw r.error;
    }
    if (typeof r.status === "number" && r.status !== 0) throw new Error(`command failed: ${cmd} ${finalArgs.join(" ")}`);
    return;
  }

  const names = [...new Set(notFound)].join(", ");
  throw new Error(`command not found: ${names || "no candidates"}`);
}

function runPython(args, { cwd } = {}) {
  const spec = resolvePythonSpec({ cwd });
  const argsPrefix = Array.isArray(spec.argsPrefix) ? spec.argsPrefix : [];
  run(spec.cmd, [...argsPrefix, ...(Array.isArray(args) ? args : [])], { cwd });
}

function resolvePythonSpec({ cwd } = {}) {
  if (cachedPythonSpec && typeof cachedPythonSpec.cmd === "string") return cachedPythonSpec;
  const candidates = [{ cmd: "python3" }, { cmd: "py", argsPrefix: ["-3"] }, { cmd: "python" }];

  for (const spec of candidates) {
    const cmd = spec.cmd;
    const argsPrefix = Array.isArray(spec.argsPrefix) ? spec.argsPrefix : [];
    const probe = spawnSync(cmd, [...argsPrefix, "--version"], { cwd, stdio: "ignore" });
    if (probe.error) {
      if (probe.error.code === "ENOENT") continue;
      continue;
    }
    if (probe.status === 0) {
      cachedPythonSpec = spec;
      return spec;
    }
  }
  throw new Error("python runtime not found (tried: python3, py -3, python)");
}

module.exports = { run, runWithFallback, runPython };
