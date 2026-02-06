const test = require("node:test");
const assert = require("node:assert/strict");

const {
  setHistorySummaryStorage,
  cacheGetFresh,
  cacheGetFreshState,
  cachePut
} = require("../payload/extension/out/byok/core/augment-history-summary/cache");
const {
  DEFAULT_SUMMARY_TAIL_REQUEST_IDS,
  computeRequestIdsHash,
  historyStartRequestId,
  tailRequestIds
} = require("../payload/extension/out/byok/core/augment-history-summary/consistency");

function makeStorage() {
  const state = {};
  return {
    get: (k) => state[k],
    update: async (k, v) => {
      state[k] = v;
    }
  };
}

function ex(id, msg = "", resp = "") {
  return {
    request_id: id,
    request_message: msg,
    response_text: resp,
    request_nodes: [],
    structured_request_nodes: [],
    nodes: [],
    response_nodes: [],
    structured_output_nodes: []
  };
}

test("historySummary cache: rejects stale when start+index+hash mismatch (edit/rollback)", async () => {
  const storage = makeStorage();
  setHistorySummaryStorage(storage);

  const history = [ex("r1", "u1"), ex("r2", "u2"), ex("r3", "u3")];
  const boundaryRequestId = "r3";
  const droppedHead = history.slice(0, 2);

  await cachePut("c1", boundaryRequestId, "SUMMARY", "s1", 1, {
    startRequestId: historyStartRequestId(history),
    summarizedUntilIndex: droppedHead.length,
    summarizedRequestIdsHash: computeRequestIdsHash(droppedHead),
    summarizedTailRequestIds: tailRequestIds(droppedHead, DEFAULT_SUMMARY_TAIL_REQUEST_IDS)
  });

  const ok = cacheGetFresh("c1", boundaryRequestId, 2, 999999, { history, droppedHead });
  assert.ok(ok);
  assert.equal(ok.summaryText, "SUMMARY");

  const edited = [ex("r1_edit", "u1"), ex("r2", "u2"), ex("r3", "u3")];
  const editedDroppedHead = edited.slice(0, 2);
  const stale = cacheGetFresh("c1", boundaryRequestId, 3, 999999, { history: edited, droppedHead: editedDroppedHead });
  assert.equal(stale, null);

  const stateOk = cacheGetFreshState("c1", 4, 999999, { history });
  assert.ok(stateOk);

  const stateStale = cacheGetFreshState("c1", 5, 999999, { history: edited });
  assert.equal(stateStale, null);
});

test("historySummary cache: accepts trimmed history when tail ids match", async () => {
  const storage = makeStorage();
  setHistorySummaryStorage(storage);

  const history = [ex("r1"), ex("r2"), ex("r3")];
  const boundaryRequestId = "r3";
  const droppedHead = history.slice(0, 2);

  await cachePut("c1", boundaryRequestId, "SUMMARY", "s1", 1, {
    startRequestId: historyStartRequestId(history),
    summarizedUntilIndex: droppedHead.length,
    summarizedRequestIdsHash: computeRequestIdsHash(droppedHead),
    summarizedTailRequestIds: ["r1", "r2"]
  });

  // 模拟前端裁剪掉最早一轮：start 变了，但 boundary 仍然存在。
  const trimmed = [ex("r2"), ex("r3")];
  const trimmedDroppedHead = trimmed.slice(0, 1);
  const ok = cacheGetFresh("c1", boundaryRequestId, 2, 999999, { history: trimmed, droppedHead: trimmedDroppedHead });
  assert.ok(ok);
  assert.equal(ok.summaryText, "SUMMARY");

  const stateOk = cacheGetFreshState("c1", 3, 999999, { history: trimmed });
  assert.ok(stateOk);
});

test("historySummary cache: rejects when boundary missing but start unchanged (rewind)", async () => {
  const storage = makeStorage();
  setHistorySummaryStorage(storage);

  const history = [ex("r1"), ex("r2"), ex("r3")];
  const boundaryRequestId = "r3";
  const droppedHead = history.slice(0, 2);

  await cachePut("c1", boundaryRequestId, "SUMMARY", "s1", 1, {
    startRequestId: historyStartRequestId(history),
    summarizedUntilIndex: droppedHead.length,
    summarizedRequestIdsHash: computeRequestIdsHash(droppedHead),
    summarizedTailRequestIds: tailRequestIds(droppedHead, DEFAULT_SUMMARY_TAIL_REQUEST_IDS)
  });

  // 模拟对话回退：history 从头开始但变短，boundary 不再出现。
  const rewound = [ex("r1"), ex("r2")];
  const stateStale = cacheGetFreshState("c1", 2, 999999, { history: rewound });
  assert.equal(stateStale, null);
});

test("historySummary cache: accepts trimmed past boundary when current start is in cached tail head ids", async () => {
  const storage = makeStorage();
  setHistorySummaryStorage(storage);

  const history = [ex("r1"), ex("r2"), ex("r3"), ex("r4"), ex("r5")];
  const boundaryRequestId = "r3";
  const droppedHead = history.slice(0, 2);
  const tail = history.slice(2);

  await cachePut("c1", boundaryRequestId, "SUMMARY", "s1", 1, {
    startRequestId: historyStartRequestId(history),
    summarizedUntilIndex: droppedHead.length,
    summarizedRequestIdsHash: computeRequestIdsHash(droppedHead),
    summarizedTailRequestIds: tailRequestIds(droppedHead, DEFAULT_SUMMARY_TAIL_REQUEST_IDS),
    summarizedTailHeadRequestIds: tail.map((h) => h.request_id)
  });

  // 模拟前端进一步裁剪：start 变了且 boundary 不在历史里，但仍在当时 tail 范围内。
  const trimmedAfterBoundary = [ex("r4"), ex("r5")];
  const stateOk = cacheGetFreshState("c1", 2, 999999, { history: trimmedAfterBoundary });
  assert.ok(stateOk);
  assert.equal(stateOk.summaryText, "SUMMARY");
});

test("historySummary cache: rejects fork when boundary missing and start shifted outside cached tail head ids", async () => {
  const storage = makeStorage();
  setHistorySummaryStorage(storage);

  const history = [ex("r1"), ex("r2"), ex("r3"), ex("r4"), ex("r5")];
  const boundaryRequestId = "r3";
  const droppedHead = history.slice(0, 2);
  const tail = history.slice(2);

  await cachePut("c1", boundaryRequestId, "OLD_SUMMARY", "s1", 1, {
    startRequestId: historyStartRequestId(history),
    summarizedUntilIndex: droppedHead.length,
    summarizedRequestIdsHash: computeRequestIdsHash(droppedHead),
    summarizedTailRequestIds: tailRequestIds(droppedHead, DEFAULT_SUMMARY_TAIL_REQUEST_IDS),
    summarizedTailHeadRequestIds: tail.map((h) => h.request_id)
  });

  // 构造分叉历史：start 变了且 boundary 不存在，也不属于当时 tail。
  const forked = [ex("f1"), ex("f2")];
  const stateStale = cacheGetFreshState("c1", 2, 999999, { history: forked });
  assert.equal(stateStale, null);
});
