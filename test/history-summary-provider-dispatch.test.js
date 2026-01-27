const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeProviderRequestDefaults } = require("../payload/extension/out/byok/core/augment-history-summary/provider-dispatch");

test("historySummary provider-dispatch: strips reasoning/thinking and tool keys", () => {
  const provider = {
    type: "openai_responses",
    requestDefaults: {
      temperature: 0.2,
      max_tokens: 123,
      reasoning: { effort: "high", summary: "auto" },
      thinking: { type: "enabled", budget_tokens: 2048 },
      tools: [{ type: "function", function: { name: "x", parameters: {} } }],
      tool_choice: "auto",
      toolChoice: "auto"
    }
  };

  const out = normalizeProviderRequestDefaults(provider, 321);

  assert.equal(out.temperature, 0.2);
  assert.equal(out.max_output_tokens, 321);
  assert.equal("max_tokens" in out, false);
  assert.equal("maxTokens" in out, false);

  assert.equal("reasoning" in out, false);
  assert.equal("thinking" in out, false);
  assert.equal("tools" in out, false);
  assert.equal("tool_choice" in out, false);
  assert.equal("toolChoice" in out, false);
});

