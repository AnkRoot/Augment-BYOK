const test = require("node:test");
const assert = require("node:assert/strict");

const { defaultConfig } = require("../payload/extension/out/byok/config/default-config");
const { maybeSummarizeAndCompactAugmentChatRequest } = require("../payload/extension/out/byok/core/augment-history-summary/auto");
const { REQUEST_NODE_HISTORY_SUMMARY } = require("../payload/extension/out/byok/core/augment-protocol");
const { makeBaseAugmentChatRequest } = require("../payload/extension/out/byok/core/self-test/builders");

function ex({ id, msg, resp, requestNodes } = {}) {
  return {
    request_id: typeof id === "string" ? id : "",
    request_message: typeof msg === "string" ? msg : "",
    response_text: typeof resp === "string" ? resp : "",
    request_nodes: Array.isArray(requestNodes) ? requestNodes : [],
    structured_request_nodes: [],
    nodes: [],
    response_nodes: [],
    structured_output_nodes: []
  };
}

function makeExistingSummaryNode() {
  return {
    type: REQUEST_NODE_HISTORY_SUMMARY,
    history_summary_node: {
      summary_text: "old summary",
      summarization_request_id: "old_sid",
      history_beginning_dropped_num_exchanges: 1,
      history_middle_abridged_text: "",
      history_end: [],
      message_template: "{summary}\n{middle_part_abridged}\n{end_part_full}"
    }
  };
}

test("historySummary: still injects when trigger comes from current message bytes", async () => {
  const cfg = defaultConfig();
  cfg.historySummary.enabled = true;
  cfg.historySummary.triggerStrategy = "chars";
  cfg.historySummary.triggerOnHistorySizeChars = 120;
  cfg.historySummary.historyTailSizeCharsToExclude = 0;
  cfg.historySummary.minTailExchanges = 2;
  cfg.historySummary.providerId = "";
  cfg.historySummary.model = "";

  const history = [
    ex({ id: "r1", msg: "u1", resp: "a1" }),
    ex({ id: "r2", msg: "u2", resp: "a2" }),
    ex({ id: "r3", msg: "u3", resp: "a3" })
  ];
  const req = makeBaseAugmentChatRequest({
    message: "m".repeat(200),
    conversationId: "conv-trigger-by-message",
    chatHistory: history
  });

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
  assert.ok(req.request_nodes.some((n) => n && n.type === REQUEST_NODE_HISTORY_SUMMARY));
});

test("historySummary: auto strategy uses dialogue fallbackModel window when requestedModel is empty", async () => {
  const cfg = defaultConfig();
  cfg.historySummary.enabled = true;
  cfg.historySummary.triggerStrategy = "auto";
  cfg.historySummary.triggerOnHistorySizeChars = 9999999;
  cfg.historySummary.triggerOnContextRatio = 0.7;
  cfg.historySummary.targetContextRatio = 0.55;
  cfg.historySummary.contextWindowTokensOverrides = { "gpt-4o": 100 };
  cfg.historySummary.historyTailSizeCharsToExclude = 0;
  cfg.historySummary.minTailExchanges = 2;
  cfg.historySummary.providerId = "";
  cfg.historySummary.model = "";

  const long = "x".repeat(200);
  const history = [
    ex({ id: "r1", msg: long, resp: long }),
    ex({ id: "r2", msg: long, resp: long }),
    ex({ id: "r3", msg: long, resp: long }),
    ex({ id: "r4", msg: long, resp: long })
  ];
  const req = makeBaseAugmentChatRequest({
    message: "continue",
    conversationId: "conv-auto-fallback-model",
    chatHistory: history
  });

  const injected = await maybeSummarizeAndCompactAugmentChatRequest({
    cfg,
    req,
    requestedModel: "",
    fallbackProvider: null,
    fallbackModel: "gpt-4o-mini",
    timeoutMs: 1000,
    abortSignal: null
  });

  assert.equal(injected, true);
  assert.ok(req.request_nodes.some((n) => n && n.type === REQUEST_NODE_HISTORY_SUMMARY));
});

test("historySummary: can refresh even when chat_history already contains summary exchange", async () => {
  const cfg = defaultConfig();
  cfg.historySummary.enabled = true;
  cfg.historySummary.triggerStrategy = "chars";
  cfg.historySummary.triggerOnHistorySizeChars = 1;
  cfg.historySummary.historyTailSizeCharsToExclude = 0;
  cfg.historySummary.minTailExchanges = 2;
  cfg.historySummary.providerId = "";
  cfg.historySummary.model = "";

  const history = [
    ex({ id: "r0", msg: "summary exchange", resp: "", requestNodes: [makeExistingSummaryNode()] }),
    ex({ id: "r1", msg: "u1", resp: "a1" }),
    ex({ id: "r2", msg: "u2", resp: "a2" }),
    ex({ id: "r3", msg: "u3", resp: "a3" })
  ];
  const req = makeBaseAugmentChatRequest({
    message: "continue",
    conversationId: "conv-refresh-existing-summary",
    chatHistory: history
  });

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
  const addedSummaryNodes = req.request_nodes.filter((n) => n && n.type === REQUEST_NODE_HISTORY_SUMMARY);
  assert.equal(addedSummaryNodes.length, 1);
});
