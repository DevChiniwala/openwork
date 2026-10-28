import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createManagedOpencodeV2Server } from "../src/managed-opencode-v2.js";
import { MCP_READINESS_RPC_ID, mcpToolId } from "../src/opencode-v2-mcp-readiness.js";

const bin = process.env.OPENWORK_TEST_OPENCODE2;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

test("the pinned native engine publishes and removes MCP tools through the readiness bridge", { skip: !bin, timeout: 60_000 }, async () => {
  if (!bin) return;
  await access(bin);
  const directory = await mkdtemp(join(tmpdir(), "openwork-native-mcp-readiness-"));
  const serverName = "readiness-witness";
  const toolName = "read_report";
  let toolLists = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const message: unknown = JSON.parse(body);
      assert.ok(record(message));
      if (!("id" in message)) { response.writeHead(202).end(); return; }
      let result: unknown;
      if (message.method === "initialize") {
        assert.ok(record(message.params));
        result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "readiness-witness", version: "1.0.0" } };
      } else if (message.method === "tools/list") {
        toolLists++;
        result = { tools: [{ name: toolName, description: "Read a local test report", inputSchema: { type: "object", properties: {} } }] };
      } else {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    } catch { response.writeHead(400).end(); }
  });
  let engine: Awaited<ReturnType<typeof createManagedOpencodeV2Server>> | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    engine = await createManagedOpencodeV2Server({ bin, rootDir: join(directory, "engine"), env: { OPENCODE_DISABLE_MODELS_FETCH: "1" } });
    const registration = await engine.fetchJson(`/api/experimental/mcp/${serverName}`, { method: "PUT", directory,
      body: { config: { type: "remote", url: `http://127.0.0.1:${address.port}/mcp`, oauth: false, protocol: "auto" } } });
    assert.equal(registration.status, 204, JSON.stringify(registration.json));
    const active = engine;
    const rpc = async (method: string) => {
      const result = await active.fetchJson(`/api/rpc/${MCP_READINESS_RPC_ID}/${method}`, { method: "POST", directory, body: { input: { server: serverName } } });
      assert.equal(result.status, 200, JSON.stringify(result.json));
      assert.ok(record(result.json));
      return result.json.output;
    };
    const wanted = { tools: [mcpToolId(serverName, toolName)] };
    const deadline = Date.now() + 20_000;
    while (true) {
      const catalog = await rpc("catalog");
      if (record(catalog) && Array.isArray(catalog.tools) && catalog.tools.includes(mcpToolId(serverName, toolName))) break;
      assert.ok(Date.now() < deadline, "native MCP discovery publishes its catalog");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepEqual(await rpc("waitForTools"), { ready: true });
    assert.deepEqual(await rpc("catalog"), wanted);
    assert.ok(toolLists > 0, "the real engine discovers the test server's tools");
    assert.equal((await engine.fetchJson(`/api/experimental/mcp/${serverName}`, { method: "DELETE", directory })).status, 204);
    assert.deepEqual(await rpc("waitForTools"), { ready: true });
    assert.deepEqual(await rpc("catalog"), { tools: [] });
  } finally {
    await engine?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
