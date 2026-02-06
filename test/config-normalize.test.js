const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeConfig } = require("../payload/extension/out/byok/config/config");

test("normalizeConfig: strips prototype-pollution keys recursively", () => {
  const raw = JSON.parse(`{
    "providers": [
      {
        "id": "p1",
        "type": "openai_compatible",
        "headers": {
          "__proto__": { "polluted": "yes" },
          "authorization": "Bearer sk-proj-1234567890abcdef1234567890abcdef",
          "content-type": "application/json"
        },
        "requestDefaults": {
          "timeoutMs": 12345,
          "constructor": { "prototype": { "polluted2": "yes" } }
        }
      }
    ],
    "historySummary": {
      "contextWindowTokensOverrides": {
        "__proto__": { "polluted3": "yes" },
        "gpt-4o": 128000
      }
    }
  }`);

  const cfg = normalizeConfig(raw);
  assert.ok(cfg && typeof cfg === "object");
  assert.equal(cfg.providers.length, 1);

  const headers = cfg.providers[0].headers;
  assert.equal(headers.authorization, "Bearer sk-proj-1234567890abcdef1234567890abcdef");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(Object.prototype.hasOwnProperty.call(headers, "__proto__"), false);
  assert.equal(headers.polluted, undefined);

  const requestDefaults = cfg.providers[0].requestDefaults;
  assert.equal(requestDefaults.timeoutMs, 12345);
  assert.equal(Object.prototype.hasOwnProperty.call(requestDefaults, "constructor"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(requestDefaults, "prototype"), false);

  const overrides = cfg.historySummary.contextWindowTokensOverrides;
  assert.equal(overrides["gpt-5.3-codex"], 400000);
  assert.equal(overrides["gpt-4o"], 128000);
  assert.equal(Object.prototype.hasOwnProperty.call(overrides, "__proto__"), false);
  assert.equal(overrides.polluted3, undefined);
});

test("normalizeConfig: routing.rules merges with defaults (and clears provider/model when not byok)", () => {
  const cfg = normalizeConfig({
    routing: {
      rules: {
        "/chat": { mode: "official", providerId: "p1", model: "m1" },
        "/unknown-endpoint": { mode: "official" }
      }
    }
  });

  assert.equal(cfg.routing.rules["/chat"].mode, "official");
  assert.equal(cfg.routing.rules["/chat"].providerId, "");
  assert.equal(cfg.routing.rules["/chat"].model, "");

  assert.equal(cfg.routing.rules["/chat-stream"].mode, "byok");
  assert.equal(cfg.routing.rules["/unknown-endpoint"], undefined);

  const cfg2 = normalizeConfig({ routing: { rules: {} } });
  assert.equal(cfg2.routing.rules["/chat"].mode, "byok");
});

test("normalizeConfig: provider.models ignores non-string entries", () => {
  const cfg = normalizeConfig({
    providers: [
      {
        id: "p1",
        type: "openai_compatible",
        baseUrl: "https://example.invalid/v1",
        models: ["a", 1, null, {}, "b", " a "],
        defaultModel: "a"
      }
    ]
  });

  assert.deepEqual(cfg.providers[0].models, ["a", "b"]);
});

test("normalizeConfig: prompts.endpointSystem is normalized and safe", () => {
  const cfg = normalizeConfig({
    prompts: {
      globalSystem: "  GLOBAL  ",
      endpointSystem: {
        "/chat": "  CHAT  ",
        "chat-stream?x=1": "  STREAM  ",
        "__proto__": { polluted: "yes" }
      }
    }
  });

  assert.equal(Object.prototype.hasOwnProperty.call(cfg.prompts, "globalSystem"), false);
  assert.equal(cfg.prompts.endpointSystem["/chat"], "CHAT");
  assert.equal(cfg.prompts.endpointSystem["/chat-stream"], "STREAM");
  assert.equal(Object.prototype.hasOwnProperty.call(cfg.prompts.endpointSystem, "__proto__"), false);
  assert.equal(cfg.prompts.endpointSystem.polluted, undefined);
});

test("normalizeConfig: drops prompts.activePresetId/presets (no prompt sets)", () => {
  const cfg = normalizeConfig({
    prompts: {
      activePresetId: "p1",
      presets: [{ id: "p1", name: "Preset 1", endpointSystem: { "/chat": "x" } }],
      endpointSystem: { "/chat": "INLINE" }
    }
  });
  assert.equal(Object.prototype.hasOwnProperty.call(cfg.prompts, "activePresetId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cfg.prompts, "presets"), false);
  assert.equal(cfg.prompts.endpointSystem["/chat"], "INLINE");
});
