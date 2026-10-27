import { afterEach, expect, spyOn, test } from "bun:test";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import { unwrap } from "../src/app/lib/opencode";

const baseUrl = "http://127.0.0.1:8787/workspace/ws_1/opencode2";
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | null = null;
afterEach(() => { fetchSpy?.mockRestore(); fetchSpy = null; });

function serve(catalog: Response | null) {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname.slice(new URL(baseUrl).pathname.length);
    if (path === "/api/model") return Response.json({ data: [{ id: "claude", providerID: "anthropic", name: "Claude" }] });
    if (path === "/api/model/default") return Response.json({ data: {} });
    if (path === "/api/provider") return Response.json({ data: [{ id: "anthropic", name: "Anthropic" }] });
    if (path === "/provider" && catalog) return catalog;
    return Response.json({ message: `Unexpected ${path}` }, { status: 404 });
  });
}

test("the connect catalog appends the server's connectable providers; only usable ones are connected", async () => {
  serve(Response.json({
    all: [
      { id: "anthropic", name: "Anthropic (catalog)", env: ["ANTHROPIC_API_KEY"], source: "api", options: {}, models: {} },
      { id: "openrouter", name: "OpenRouter", env: ["OPENROUTER_API_KEY"], source: "api", options: {}, models: {} },
    ],
    connected: [],
    default: {},
  }));
  const client = createClientV2(baseUrl, "/tmp/ws_1", { token: "t" });
  const catalog = unwrap(await client.provider.list({ directory: "/tmp/ws_1" }));
  expect(catalog.all.map((provider) => provider.id)).toEqual(["anthropic", "openrouter"]);
  expect(catalog.all[0]?.name).toBe("Anthropic");
  expect(catalog.all[1]).toEqual({ id: "openrouter", name: "OpenRouter", source: "api", env: ["OPENROUTER_API_KEY"], options: {}, models: {} });
  expect(catalog.connected).toEqual(["anthropic"]);

  const connected = unwrap(await client.config.providers({ directory: "/tmp/ws_1" }));
  expect(connected.providers.map((provider) => provider.id)).toEqual(["anthropic"]);
});

test("a missing server catalog still lists usable providers", async () => {
  serve(null);
  const client = createClientV2(baseUrl, undefined, { token: "t" });
  const catalog = unwrap(await client.provider.list());
  expect(catalog.all.map((provider) => provider.id)).toEqual(["anthropic"]);
  expect(catalog.connected).toEqual(["anthropic"]);
});
