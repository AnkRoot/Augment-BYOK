const test = require("node:test");
const assert = require("node:assert/strict");

const {
  convertToolDefinitionsByProviderType,
  completeAugmentChatTextByProviderType,
  streamAugmentChatChunksByProviderType
} = require("../payload/extension/out/byok/core/provider-augment-chat");

test("provider-augment-chat: convertToolDefinitionsByProviderType returns provider-specific shapes", () => {
  const toolDefs = [
    {
      name: "echo",
      description: "Echo text",
      input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
    },
    {
      name: "optional_fields",
      description: "Has optional properties",
      input_schema: {
        type: "object",
        properties: { required: { type: "string" }, optional: { type: "string" } },
        required: ["required"]
      }
    }
  ];

  const openAi = convertToolDefinitionsByProviderType("openai_compatible", toolDefs);
  assert.equal(openAi.length, 2);
  assert.equal(openAi[0].type, "function");
  assert.equal(openAi[0].function.name, "echo");

  const responses = convertToolDefinitionsByProviderType("openai_responses", toolDefs);
  assert.equal(responses.length, 2);
  assert.equal(responses[0].type, "function");
  assert.equal(responses[0].name, "echo");
  assert.equal(responses[0].strict, true);
  assert.equal(responses[0].parameters.additionalProperties, false);
  assert.ok(Array.isArray(responses[0].parameters.required));
  assert.ok(responses[0].parameters.required.includes("text"));
  assert.deepEqual(responses[1].parameters.required, ["required", "optional"]);

  const anthropic = convertToolDefinitionsByProviderType("anthropic", toolDefs);
  assert.equal(anthropic.length, 2);
  assert.equal(anthropic[0].name, "echo");
  assert.equal(anthropic[0].input_schema.type, "object");

  const gemini = convertToolDefinitionsByProviderType("gemini_ai_studio", toolDefs);
  assert.equal(gemini.length, 1);
  assert.ok(Array.isArray(gemini[0].functionDeclarations));
  assert.equal(gemini[0].functionDeclarations[0].name, "echo");
  assert.equal(gemini[0].functionDeclarations[1].name, "optional_fields");
});

test("provider-augment-chat: unknown provider.type throws without network", async () => {
  await assert.rejects(
    async () => {
      await completeAugmentChatTextByProviderType({ type: "unknown", baseUrl: "x", apiKey: "y", model: "z", req: {} });
    },
    (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      return msg.includes("未知 provider.type") && msg.includes("openai_compatible") && msg.includes("gemini_ai_studio");
    }
  );

  const gen = streamAugmentChatChunksByProviderType({ type: "unknown", baseUrl: "x", apiKey: "y", model: "z", req: { tool_definitions: [] } });
  await assert.rejects(async () => {
    // eslint-disable-next-line no-unused-vars
    for await (const _ of gen) break;
  });
});
