const test = require("node:test");
const assert = require("node:assert/strict");

const {
  renderHistorySummaryNodeValue,
  applyEmergencyContextCompactionForRetry
} = require("../payload/extension/out/byok/core/augment-history-summary");
const { REQUEST_NODE_HISTORY_SUMMARY, REQUEST_NODE_TOOL_RESULT } = require("../payload/extension/out/byok/core/augment-protocol");

function makeHistoryEndExchange({ id, toolResult } = {}) {
  return {
    request_message: `u${id ?? ""}`,
    response_text: `a${id ?? ""}`,
    request_nodes: toolResult
      ? [
          {
            type: REQUEST_NODE_TOOL_RESULT,
            tool_result_node: { tool_use_id: "tool_1", content: "ok" }
          }
        ]
      : [],
    response_nodes: []
  };
}

test("historySummary: end_part_full supports truncation via end_part_full_max_chars", () => {
  const huge = "x".repeat(20000);
  const v = {
    message_template: "{end_part_full}",
    summary_text: "",
    summarization_request_id: "sid",
    history_beginning_dropped_num_exchanges: 0,
    history_middle_abridged_text: "",
    history_end: [{ request_message: huge, response_text: "", request_nodes: [], response_nodes: [] }],
    end_part_full_max_chars: 1000,
    end_part_full_tail_chars: 200
  };

  const rendered = renderHistorySummaryNodeValue(v, []);
  assert.ok(rendered);
  assert.ok(rendered.length <= 1000);
  assert.ok(rendered.includes("…"));
});

test("historySummary: end_part_full includes response_text when response_nodes empty", () => {
  const v = {
    message_template: "{end_part_full}",
    summary_text: "",
    summarization_request_id: "sid",
    history_beginning_dropped_num_exchanges: 0,
    history_middle_abridged_text: "",
    history_end: [{ request_message: "u", response_text: "assistant says hi", request_nodes: [], response_nodes: [] }]
  };

  const rendered = renderHistorySummaryNodeValue(v, []);
  assert.ok(rendered);
  assert.ok(rendered.includes("assistant says hi"));
});

test("historySummary: placeholder replacement does not replace inside inserted values", () => {
  const v = {
    message_template: "SUMMARY:\n{summary}\nEND:\n{end_part_full}",
    summary_text: "keep {end_part_full} literal",
    summarization_request_id: "sid",
    history_beginning_dropped_num_exchanges: 0,
    history_middle_abridged_text: "",
    history_end: [{ request_message: "u", response_text: "a", request_nodes: [], response_nodes: [] }]
  };

  const rendered = renderHistorySummaryNodeValue(v, []);
  assert.ok(rendered);
  assert.ok(rendered.includes("keep {end_part_full} literal"));
});

test("context-retry fallback: shrinks history_end and avoids tool_result orphan starts", () => {
  const req = {
    message: "hi",
    chat_history: [],
    request_nodes: [
      {
        type: REQUEST_NODE_HISTORY_SUMMARY,
        history_summary_node: {
          message_template: "{end_part_full}",
          summary_text: "s",
          summarization_request_id: "sid",
          history_beginning_dropped_num_exchanges: 0,
          history_middle_abridged_text: "",
          history_end: [
            makeHistoryEndExchange({ id: 0 }),
            makeHistoryEndExchange({ id: 1 }),
            makeHistoryEndExchange({ id: 2, toolResult: true }),
            makeHistoryEndExchange({ id: 3 }),
            makeHistoryEndExchange({ id: 4 }),
            makeHistoryEndExchange({ id: 5 })
          ]
        }
      }
    ]
  };

  const res = applyEmergencyContextCompactionForRetry(req, { level: 2 });
  assert.ok(res.changed);
  assert.equal(res.kind, "summary");

  const node = req.request_nodes[0];
  assert.equal(node.type, REQUEST_NODE_HISTORY_SUMMARY);
  const hs = node.history_summary_node;
  assert.equal(hs.end_part_full_max_chars, 30000);
  assert.equal(hs.history_end.length, 3);
});

test("context-retry fallback: shrinks chat_history when no HISTORY_SUMMARY node exists", () => {
  const history = Array.from({ length: 20 }, (_, i) => ({
    request_id: `r${i}`,
    request_message: `u${i}`,
    response_text: `a${i}`,
    request_nodes: [],
    structured_request_nodes: [],
    nodes: [],
    response_nodes: [],
    structured_output_nodes: []
  }));

  const req = { message: "hi", chat_history: history, request_nodes: [], nodes: [], structured_request_nodes: [] };
  const res = applyEmergencyContextCompactionForRetry(req, { level: 2 });
  assert.ok(res.changed);
  assert.equal(res.kind, "history");
  assert.equal(req.chat_history.length, 6);
});
