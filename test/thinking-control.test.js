const test = require("node:test");
const assert = require("node:assert/strict");

const {
  REQUEST_NODE_TEXT,
  REQUEST_NODE_TOOL_RESULT
} = require("../payload/extension/out/byok/core/augment-protocol");
const { isUserDialogueTurn, shouldRequestThinking, stripThinkingAndReasoningFromRequestDefaults } = require("../payload/extension/out/byok/core/thinking-control");

test("thinking-control: isUserDialogueTurn true for message", () => {
  assert.equal(isUserDialogueTurn({ message: "hi" }), true);
});

test("thinking-control: shouldRequestThinking true for normal user turn", () => {
  assert.equal(shouldRequestThinking({ message: "hi" }), true);
});

test("thinking-control: isUserDialogueTurn false for tool-only continuation", () => {
  const req = {
    message: "",
    request_nodes: [
      { type: REQUEST_NODE_TOOL_RESULT, tool_result_node: { tool_use_id: "t1", content: "ok" } }
    ]
  };
  assert.equal(isUserDialogueTurn(req), false);
});

test("thinking-control: shouldRequestThinking false when tool results are present (even if message repeats)", () => {
  const req = {
    message: "hi",
    request_nodes: [
      { type: REQUEST_NODE_TOOL_RESULT, tool_result_node: { tool_use_id: "t1", content: "ok" } }
    ]
  };
  assert.equal(shouldRequestThinking(req), false);
});

test("thinking-control: isUserDialogueTurn true for text nodes even without message", () => {
  const req = {
    message: "",
    request_nodes: [
      { type: REQUEST_NODE_TEXT, text_node: { content: "hello" } }
    ]
  };
  assert.equal(isUserDialogueTurn(req), true);
});

test("thinking-control: stripThinkingAndReasoningFromRequestDefaults does not mutate input", () => {
  const rd = { temperature: 0.1, reasoning: { effort: "high" }, thinking: { type: "enabled", budget_tokens: 1024 } };
  const out = stripThinkingAndReasoningFromRequestDefaults(rd);

  assert.notStrictEqual(out, rd);
  assert.equal("reasoning" in out, false);
  assert.equal("thinking" in out, false);

  assert.equal("reasoning" in rd, true);
  assert.equal("thinking" in rd, true);
});
