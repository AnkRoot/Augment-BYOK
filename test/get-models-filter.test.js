const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { maybeHandleCallApi } = require("../payload/extension/out/byok/runtime/shim/call-api");

function startGetModelsServer(responseJson) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/get-models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responseJson));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}/` });
    });
  });
}

test("handleGetModels: filters upstream official models when BYOK models exist", async () => {
  const { server, baseUrl } = await startGetModelsServer({
    default_model: "official-default",
    models: [{ name: "official-a" }, { name: "official-b" }],
    feature_flags: { some_flag: true, model_registry: JSON.stringify({ "Official A": "official-a" }) }
  });

  try {
    const out = await maybeHandleCallApi({ endpoint: "/get-models", body: {}, timeoutMs: 2000, upstreamCompletionURL: baseUrl });
    assert.ok(out && typeof out === "object");
    assert.equal(out.default_model, "byok:openai:gpt-5.2");
    assert.ok(Array.isArray(out.models));
    assert.ok(out.models.length > 0);
    for (const m of out.models) {
      assert.equal(typeof m.name, "string");
      assert.ok(m.name.startsWith("byok:"), `unexpected model leaked into picker: ${m.name}`);
    }

    const flags = out.feature_flags;
    assert.ok(flags && typeof flags === "object");
    assert.equal(flags.some_flag, true);

    const registryRaw = flags.model_registry ?? flags.modelRegistry;
    assert.equal(typeof registryRaw, "string");
    const registry = JSON.parse(registryRaw);
    assert.ok(registry && typeof registry === "object");
    for (const v of Object.values(registry)) {
      assert.equal(typeof v, "string");
      assert.ok(v.startsWith("byok:"), `unexpected registry entry leaked into picker: ${v}`);
    }
    assert.ok(!Object.values(registry).includes("official-a"));
  } finally {
    await new Promise((r) => server.close(r));
  }
});
