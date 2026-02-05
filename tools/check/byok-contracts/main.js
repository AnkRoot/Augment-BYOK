"use strict";

const fs = require("fs");
const path = require("path");

const { ok, assert, readText, readJson, parseArgs } = require("./util");
const { assertFileExists, assertContains, assertHasCommand, assertModelRegistryFlags } = require("./assertions");
const { assertCallApiShimSignatureContracts } = require("./check-callapi-shim");
const { assertProtocolEnumsAligned } = require("./check-protocol-enums");
const { assertAugmentProtocolShapes } = require("./check-augment-protocol-shapes");

function main(argv = process.argv) {
  const args = parseArgs(argv);
  const extensionDir = path.resolve(String(args.extensionDir || ""));
  const extJsPath = path.resolve(String(args.extJs || ""));
  const pkgPath = path.resolve(String(args.pkg || ""));

  assert(extensionDir && extensionDir !== path.parse(extensionDir).root, "missing --extensionDir");
  assert(extJsPath && extJsPath !== path.parse(extJsPath).root, "missing --extJs");
  assert(pkgPath && pkgPath !== path.parse(pkgPath).root, "missing --pkg");

  ok(`extensionDir=${extensionDir}`);

  assert(fs.existsSync(extensionDir), `extensionDir not found: ${extensionDir}`);
  assert(fs.existsSync(extJsPath), `extJs not found: ${extJsPath}`);
  assert(fs.existsSync(pkgPath), `package.json not found: ${pkgPath}`);

  const requiredRelFiles = [
    "out/byok/runtime/bootstrap/index.js",
    "out/byok/runtime/official/common.js",
    "out/byok/runtime/official/get-models.js",
    "out/byok/runtime/official/codebase-retrieval.js",
    "out/byok/runtime/official/context-canvas.js",
    "out/byok/runtime/official/external-sources.js",
    "out/byok/runtime/shim/call-api/index.js",
    "out/byok/runtime/shim/call-api-stream/index.js",
    "out/byok/runtime/shim/byok-chat/index.js",
    "out/byok/runtime/shim/byok-chat-stream/index.js",
    "out/byok/runtime/shim/byok-text/index.js",
    "out/byok/runtime/shim/route/index.js",
    "out/byok/runtime/shim/next-edit/index.js",
    "out/byok/runtime/shim/common/index.js",
    "out/byok/runtime/shim/augment-chat/index.js",
    "out/byok/runtime/upstream/discovery.js",
    "out/byok/runtime/upstream/assets.js",
    "out/byok/runtime/upstream/checkpoints.js",
    "out/byok/runtime/workspace/file-chunks.js",
    "out/byok/config/config.js",
    "out/byok/config/default-config.js",
    "out/byok/config/normalize-config.js",
    "out/byok/config/state.js",
    "out/byok/config/official.js",
    "out/byok/core/router.js",
    "out/byok/core/protocol.js",
    "out/byok/core/model-registry.js",
    "out/byok/core/model-picker.js",
    "out/byok/core/augment-protocol.js",
    "out/byok/core/provider-types.js",
    "out/byok/core/provider-text.js",
    "out/byok/core/provider-augment-chat.js",
    "out/byok/core/augment-node-format.js",
    "out/byok/core/tool-pairing/index.js",
    "out/byok/core/augment-history-summary/index.js",
    "out/byok/core/augment-history-summary/abridged.js",
    "out/byok/core/augment-history-summary/cache.js",
    "out/byok/core/augment-history-summary/provider-dispatch.js",
    "out/byok/core/augment-history-summary/auto/index.js",
    "out/byok/core/augment-history-summary/auto/estimate.js",
    "out/byok/core/augment-history-summary/auto/config.js",
    "out/byok/core/augment-history-summary/auto/tail-selection.js",
    "out/byok/core/augment-chat/shared/index.js",
    "out/byok/core/augment-chat/shared/nodes.js",
    "out/byok/core/augment-chat/shared/tools.js",
    "out/byok/core/augment-chat/shared/request.js",
    "out/byok/core/augment-chat/openai.js",
    "out/byok/core/augment-chat/openai-responses.js",
    "out/byok/core/augment-chat/anthropic.js",
    "out/byok/core/augment-chat/gemini.js",
    "out/byok/core/tool-pairing/common.js",
    "out/byok/core/tool-pairing/openai.js",
    "out/byok/core/tool-pairing/openai-responses.js",
    "out/byok/core/tool-pairing/anthropic.js",
    "out/byok/core/next-edit/fields.js",
    "out/byok/core/next-edit/loc-utils.js",
    "out/byok/core/next-edit/stream-utils.js",
    "out/byok/prompts/next-edit-stream.js",
    "out/byok/prompts/next-edit-loc.js",
    "out/byok/infra/constants.js",
    "out/byok/infra/util.js",
    "out/byok/infra/log.js",
    "out/byok/providers/openai/index.js",
    "out/byok/providers/chat-chunks-util.js",
    "out/byok/providers/openai/chat-completions-util.js",
    "out/byok/providers/openai/chat-completions-json-util.js",
    "out/byok/providers/openai-responses/index.js",
    "out/byok/providers/openai-responses/request.js",
    "out/byok/providers/openai-responses/json-util.js",
    "out/byok/providers/anthropic/index.js",
    "out/byok/providers/anthropic/request.js",
    "out/byok/providers/anthropic/json-util.js",
    "out/byok/providers/gemini/index.js",
    "out/byok/providers/gemini/json-util.js",
    "out/byok/ui/config-io.js",
    "out/byok/ui/config-panel/index.js",
    "out/byok/ui/config-panel/html.js",
    "out/byok/ui/config-panel/style.css",
    "out/byok/ui/config-panel/webview/util.js",
    "out/byok/ui/config-panel/webview/render/index.js",
    "out/byok/ui/config-panel/webview/render/providers.js",
    "out/byok/ui/config-panel/webview/render/endpoints.js",
    "out/byok/ui/config-panel/webview/render/app.js",
    "out/byok/ui/config-panel/webview/dom.js",
    "out/byok/ui/config-panel/webview/core.js",
    "out/byok/ui/config-panel/webview/handlers.js",
    "out/byok/ui/config-panel/webview/main.js"
  ];
  for (const rel of requiredRelFiles) assertFileExists(extensionDir, rel);
  ok(`required files ok (${requiredRelFiles.length})`);

  const pkg = readJson(pkgPath);
  assertHasCommand(pkg, "augment-byok.enable");
  assertHasCommand(pkg, "augment-byok.disable");
  assertHasCommand(pkg, "augment-byok.reloadConfig");
  assertHasCommand(pkg, "augment-byok.openConfigPanel");
  assertHasCommand(pkg, "augment-byok.clearHistorySummaryCache");
  assertHasCommand(pkg, "augment-byok.importConfig");
  assertHasCommand(pkg, "augment-byok.exportConfig");
  ok("package.json commands ok");

  const extJs = readText(extJsPath);
  assertContains(extJs, "__augment_byok_augment_interceptor_injected_v1", "augment interceptor injected");
  assertContains(extJs, "__augment_byok_bootstrap_injected_v1", "bootstrap injected");
  assertContains(extJs, "__augment_byok_expose_upstream_v1", "expose upstream (toolsModel) injected");
  assertContains(extJs, "__augment_byok_official_overrides_patched_v1", "official overrides patched");
  assertContains(extJs, "__augment_byok_callapi_shim_patched_v1", "callApi shim patched");
  assertContains(extJs, "__augment_byok_model_picker_byok_only_v1", "model picker (BYOK-only) patched");
  assertContains(extJs, "__augment_byok_memories_upper_bound_size_patched_v1", "memories upper_bound_size patched");
  assertContains(extJs, "__augment_byok_tasklist_auto_root_patched_v1", "tasklist auto root patched");
  assertContains(extJs, "__augment_byok_tasklist_add_tasks_sanitize_empty_ids_patched_v1", "tasklist add_tasks sanitize empty ids patched");
  assertContains(extJs, "__augment_byok_tasklist_add_tasks_errors_patched_v1", "tasklist add_tasks errors patched");
  assert(!extJs.includes("case \"/autoAuth\"") && !extJs.includes("handleAutoAuth"), "autoAuth guard failed (post-check)");
  ok("extension.js markers ok");

  assertCallApiShimSignatureContracts(extJs);

  const byokDir = path.join(extensionDir, "out", "byok");
  const coreDir = path.join(byokDir, "core");
  const configDir = path.join(byokDir, "config");
  const infraDir = path.join(byokDir, "infra");
  const modelRegistry = require(path.join(coreDir, "model-registry.js"));
  const protocol = require(path.join(coreDir, "protocol.js"));
  const augmentProtocol = require(path.join(coreDir, "augment-protocol.js"));
  const augmentChatShared = require(path.join(coreDir, "augment-chat", "shared", "index.js"));
  const augmentNodeFormat = require(path.join(coreDir, "augment-node-format.js"));
  const config = require(path.join(configDir, "config.js"));
  const router = require(path.join(coreDir, "router.js"));
  const util = require(path.join(infraDir, "util.js"));

  assertProtocolEnumsAligned(extensionDir, augmentProtocol, augmentChatShared, augmentNodeFormat);
  assertAugmentProtocolShapes(augmentProtocol);

  const sampleByokId = "byok:openai:gpt-4o-mini";
  const flags = modelRegistry.ensureModelRegistryFeatureFlags({}, { byokModelIds: [sampleByokId], defaultModel: sampleByokId });
  assertModelRegistryFlags(flags);
  const regJson = JSON.parse(flags.modelRegistry || flags.model_registry || "{}");
  assert(regJson["openai: gpt-4o-mini"] === sampleByokId, "modelRegistry missing mapping: openai: gpt-4o-mini");
  ok("model registry flags ok");

  const getModels = protocol.makeBackGetModelsResult({ defaultModel: sampleByokId, models: [protocol.makeModelInfo(sampleByokId)] });
  assert(getModels && typeof getModels === "object", "makeBackGetModelsResult not object");
  assertModelRegistryFlags(getModels.feature_flags);
  ok("makeBackGetModelsResult contract ok");

  const cfg = config.defaultConfig();
  const r = router.decideRoute({ cfg, endpoint: "/chat-stream", body: { model: sampleByokId }, runtimeEnabled: true });
  assert(r && r.mode === "byok", "router.decideRoute expected mode=byok");
  assert(r.provider && r.provider.id === "openai", "router.decideRoute expected provider=openai");
  assert(r.model === "gpt-4o-mini", "router.decideRoute expected model=gpt-4o-mini");
  ok("router decideRoute contract ok");

  assert(util.parseByokModelId(sampleByokId)?.providerId === "openai", "util.parseByokModelId parse failed");
  let threw = false;
  try {
    util.parseByokModelId("byok:badformat", { strict: true });
  } catch {
    threw = true;
  }
  assert(threw, "util.parseByokModelId(strict) should throw on invalid byok format");
  ok("util parseByokModelId contract ok");

  ok("ALL CONTRACTS OK");
}

module.exports = { main };

if (require.main === module) main();
