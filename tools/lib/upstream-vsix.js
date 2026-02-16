"use strict";

const fs = require("fs");
const path = require("path");

const { ensureDir, rmDir } = require("./fs");
const { runPython } = require("./run");
const { downloadFile } = require("./http");

const DEFAULT_UPSTREAM_VSIX_URL =
  "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/augment/vsextensions/vscode-augment/latest/vspackage";
const DEFAULT_UPSTREAM_VSIX_REL_PATH = ".cache/upstream/augment.vscode-augment.latest.vsix";

async function ensureUpstreamVsix({ upstreamUrl, vsixPath, skipDownload }) {
  const url = String(upstreamUrl || "");
  const outPath = String(vsixPath || "");
  const skip = Boolean(skipDownload);

  if (!outPath) throw new Error("ensureUpstreamVsix: missing vsixPath");
  if (skip) {
    if (!fs.existsSync(outPath)) throw new Error(`cached upstream VSIX missing: ${outPath}`);
    return { downloaded: false, path: outPath };
  }

  if (!url) throw new Error("ensureUpstreamVsix: missing upstreamUrl");
  await downloadFile(url, outPath);
  return { downloaded: true, path: outPath };
}

function unpackVsixToWorkDir({ repoRoot, vsixPath, workDir, clean }) {
  const root = path.resolve(String(repoRoot || ""));
  const vsixAbs = path.resolve(String(vsixPath || ""));
  const workAbs = path.resolve(String(workDir || ""));
  const shouldClean = clean !== false;

  if (!root || root === path.parse(root).root) throw new Error("unpackVsixToWorkDir: invalid repoRoot");
  if (!vsixAbs || vsixAbs === path.parse(vsixAbs).root) throw new Error("unpackVsixToWorkDir: invalid vsixPath");
  if (!workAbs || workAbs === path.parse(workAbs).root) throw new Error("unpackVsixToWorkDir: invalid workDir");
  if (!fs.existsSync(vsixAbs)) throw new Error(`unpackVsixToWorkDir: VSIX missing: ${path.relative(root, vsixAbs)}`);

  if (shouldClean) rmDir(workAbs);
  ensureDir(workAbs);

  runPython([path.join(root, "tools", "lib", "unzip-dir.py"), "--in", vsixAbs, "--out", workAbs], { cwd: root });

  const extensionDir = path.join(workAbs, "extension");
  const pkgPath = path.join(extensionDir, "package.json");
  const extJsPath = path.join(extensionDir, "out", "extension.js");

  if (!fs.existsSync(pkgPath)) throw new Error(`missing unpacked file: ${path.relative(root, pkgPath)}`);
  if (!fs.existsSync(extJsPath)) throw new Error(`missing unpacked file: ${path.relative(root, extJsPath)}`);

  return { workDir: workAbs, extensionDir, pkgPath, extJsPath, vsixPath: vsixAbs };
}

module.exports = {
  DEFAULT_UPSTREAM_VSIX_URL,
  DEFAULT_UPSTREAM_VSIX_REL_PATH,
  ensureUpstreamVsix,
  unpackVsixToWorkDir
};
