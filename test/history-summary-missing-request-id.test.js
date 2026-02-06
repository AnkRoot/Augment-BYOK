const test = require("node:test");
const assert = require("node:assert/strict");

const { defaultConfig } = require("../payload/extension/out/byok/config/default-config");
const { maybeSummarizeAndCompactAugmentChatRequest } = require("../payload/extension/out/byok/core/augment-history-summary/auto");
const { REQUEST_NODE_HISTORY_SUMMARY } = require("../payload/extension/out/byok/core/augment-protocol");
const { makeBaseAugmentChatRequest } = require("../payload/extension/out/byok/core/self-test/builders");

function ex({ msg, resp } = {}) {
  return {
    request_id: "",
    request_message: typeof msg === "string" ? msg : "u " + "x".repeat(2000),
    response_text: typeof resp === "string" ? resp : "a " + "y".repeat(2000),
    request_nodes: [],
    structured_request_nodes: [],
    nodes: [],
    response_nodes: [],
    structured_output_nodes: []
  };
}

test("historySummary: injects even when request_id is missing", async () => {
  const cfg = defaultConfig();
  cfg.historySummary.enabled = true;
  cfg.historySummary.triggerStrategy = "chars";
  cfg.historySummary.triggerOnHistorySizeChars = 1;
  cfg.historySummary.historyTailSizeCharsToExclude = 0;
  cfg.historySummary.minTailExchanges = 2;
  cfg.historySummary.providerId = "";
  cfg.historySummary.model = "";

  const history = [ex(), ex(), ex(), ex()];
  const req = makeBaseAugmentChatRequest({ message: "continue", conversationId: "c1", chatHistory: history });

  const injected = await maybeSummarizeAndCompactAugmentChatRequest({
    cfg,
    req,
    requestedModel: "byok:openai:gpt-4o-mini",
    fallbackProvider: null,
    fallbackModel: "",
    timeoutMs: 1000,
    abortSignal: null
  });

  assert.equal(injected, true);
  assert.ok(Array.isArray(req.request_nodes));
  assert.ok(req.request_nodes.some((n) => n && n.type === REQUEST_NODE_HISTORY_SUMMARY));
});

