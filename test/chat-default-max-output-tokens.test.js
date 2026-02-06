const test = require("node:test");
const assert = require("node:assert/strict");

const { buildByokAugmentChatContext } = require("../payload/extension/out/byok/runtime/shim/augment-chat");

function makeProvider({ type, requestDefaults }) {
  return {
    id: "p1",
    type,
    baseUrl: "https://example.invalid",
    apiKey: "",
    headers: { authorization: "Bearer test" },
    requestDefaults: requestDefaults && typeof requestDefaults === "object" ? requestDefaults : {}
  };
}

async function buildCtx({ provider, kind } = {}) {
  const k = kind === "chat" ? "chat" : "chat-stream";
  const ep = k === "chat" ? "/chat" : "/chat-stream";
  return await buildByokAugmentChatContext({
    kind: k,
    endpoint: ep,
    cfg: {},
    provider,
    model: "gpt-5.3-codex",
    requestedModel: "gpt-5.3-codex",
    body: { message: "hi" },
    timeoutMs: 1,
    abortSignal: null,
    upstreamCompletionURL: "",
    upstreamApiToken: "",
    requestId: "r1"
  });
}

test("buildByokAugmentChatContext: injects auto max_output_tokens when requestDefaults missing", async () => {
  const ctx = await buildCtx({ provider: makeProvider({ type: "openai_compatible", requestDefaults: {} }), kind: "chat-stream" });
  assert.equal(ctx.requestDefaults.max_output_tokens, 65536);
});

test("buildByokAugmentChatContext: does not override explicit max_tokens", async () => {
  const ctx = await buildCtx({ provider: makeProvider({ type: "openai_compatible", requestDefaults: { max_tokens: 123 } }), kind: "chat" });
  assert.equal(ctx.requestDefaults.max_tokens, 123);
  assert.equal(ctx.requestDefaults.max_output_tokens, undefined);
});

test("buildByokAugmentChatContext: does not override explicit max_output_tokens", async () => {
  const ctx = await buildCtx({ provider: makeProvider({ type: "openai_responses", requestDefaults: { max_output_tokens: 321 } }), kind: "chat-stream" });
  assert.equal(ctx.requestDefaults.max_output_tokens, 321);
});

test("buildByokAugmentChatContext: respects gemini generationConfig.maxOutputTokens", async () => {
  const ctx = await buildCtx({
    provider: makeProvider({ type: "gemini_ai_studio", requestDefaults: { generationConfig: { maxOutputTokens: 99 } } }),
    kind: "chat-stream"
  });
  assert.deepEqual(ctx.requestDefaults.generationConfig, { maxOutputTokens: 99 });
  assert.equal(ctx.requestDefaults.max_output_tokens, undefined);
});

test("buildByokAugmentChatContext: auto max_output_tokens accounts for multibyte (CJK) prompts", async () => {
  const provider = makeProvider({ type: "openai_compatible", requestDefaults: {} });
  const big = "你".repeat(500000);

  const ctx = await buildByokAugmentChatContext({
    kind: "chat-stream",
    endpoint: "/chat-stream",
    cfg: {},
    provider,
    model: "gpt-5.3-codex",
    requestedModel: "gpt-5.3-codex",
    body: { message: big },
    timeoutMs: 1,
    abortSignal: null,
    upstreamCompletionURL: "",
    upstreamApiToken: "",
    requestId: "r_big_cjk"
  });

  assert.ok(Number.isFinite(Number(ctx.requestDefaults.max_output_tokens)));
  assert.ok(ctx.requestDefaults.max_output_tokens < 65536);
  assert.ok(ctx.requestDefaults.max_output_tokens >= 256);
});
