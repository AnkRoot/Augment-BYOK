#!/usr/bin/env node
"use strict";

const path = require("path");

const { getArgValue, hasFlag } = require("../lib/cli-args");
const { sha256FileHex } = require("../lib/hash");
const { ensureDir, rmDir, readJson, writeJson } = require("../lib/fs");
const { runPython } = require("../lib/run");
const { applyByokPatches, runByokContractChecks } = require("../lib/byok-workflow");
const { DEFAULT_UPSTREAM_VSIX_URL, DEFAULT_UPSTREAM_VSIX_REL_PATH, ensureUpstreamVsix, unpackVsixToWorkDir } = require("../lib/upstream-vsix");

async function main() {
  const repoRoot = path.resolve(__dirname, "../..");
  const cacheDir = path.join(repoRoot, ".cache");
  const distDir = path.join(repoRoot, "dist");
  ensureDir(distDir);

  const upstreamUrl = DEFAULT_UPSTREAM_VSIX_URL;
  const upstreamVsixPath = path.resolve(repoRoot, getArgValue(process.argv, "--upstream-vsix") || DEFAULT_UPSTREAM_VSIX_REL_PATH);
  const skipDownload = hasFlag(process.argv, "--skip-download") || process.env.AUGMENT_BYOK_SKIP_UPSTREAM_DOWNLOAD === "1";

  if (skipDownload) {
    console.log(`[build] reuse cached upstream VSIX: ${path.relative(repoRoot, upstreamVsixPath)}`);
  } else {
    console.log(`[build] download upstream VSIX`);
  }
  await ensureUpstreamVsix({ upstreamUrl, vsixPath: upstreamVsixPath, skipDownload });
  const upstreamSha = sha256FileHex(upstreamVsixPath);

  const workDir = path.join(cacheDir, "work", "latest");
  console.log(`[build] unpack VSIX -> ${path.relative(repoRoot, workDir)}`);
  const { extensionDir, pkgPath, extJsPath } = unpackVsixToWorkDir({ repoRoot, vsixPath: upstreamVsixPath, workDir, clean: true });

  const upstreamPkg = readJson(pkgPath);
  const upstreamVersion = typeof upstreamPkg?.version === "string" ? upstreamPkg.version : "unknown";

  const interceptorInjectPath = path.join(repoRoot, "vendor", "augment-interceptor", "inject-code.augment-interceptor.v1.2.txt");
  const interceptorInjectSha = sha256FileHex(interceptorInjectPath);
  applyByokPatches({
    repoRoot,
    extensionDir,
    pkgPath,
    extJsPath,
    interceptorInjectPath,
    logPrefix: "build"
  });

  runByokContractChecks({ repoRoot, extensionDir, extJsPath, pkgPath, logPrefix: "build" });

  const outName = `augment.vscode-augment.${upstreamVersion}.byok.vsix`;
  const outPath = path.join(distDir, outName);
  console.log(`[build] repack VSIX -> ${path.relative(repoRoot, outPath)}`);
  runPython([path.join(repoRoot, "tools", "lib", "zip-dir.py"), "--src", workDir, "--out", outPath], { cwd: repoRoot });

  const outSha = sha256FileHex(outPath);
  const lockPath = path.join(distDir, "upstream.lock.json");
  writeJson(lockPath, {
    upstream: { version: upstreamVersion, url: upstreamUrl, sha256: upstreamSha },
    interceptorInject: { file: path.relative(repoRoot, interceptorInjectPath), sha256: interceptorInjectSha },
    output: { file: outName, sha256: outSha },
    generatedAt: new Date().toISOString()
  });

  const stableLockPath = path.join(repoRoot, "upstream.lock.json");
  writeJson(stableLockPath, {
    upstream: { version: upstreamVersion, url: upstreamUrl, sha256: upstreamSha },
    interceptorInject: { file: path.relative(repoRoot, interceptorInjectPath), sha256: interceptorInjectSha }
  });

  console.log(`[build] done: ${path.relative(repoRoot, outPath)}`);

  const keepWorkDir = process.env.AUGMENT_BYOK_KEEP_WORKDIR === "1";
  if (!keepWorkDir) {
    console.log(`[build] cleanup workdir`);
    rmDir(workDir);
  }
}

main().catch((err) => {
  console.error(`[build] ERROR:`, err && err.stack ? err.stack : String(err));
  process.exit(1);
});
