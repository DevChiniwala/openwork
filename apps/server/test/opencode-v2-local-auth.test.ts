import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { mapRuntimeProvidersToV2Specs } from "../src/engine-v2-preview.js";
import { renderOpencodeV2Config } from "../src/managed-opencode-v2.js";
import { buildOpenworkRuntimeConfigObjectFromSnapshot } from "../src/openwork-runtime-config.js";
import {
  createLocalProviderCatalog,
  localProviderDefinitions,
  normalizeLocalProviderDefinition,
  readLocalProviderAuth,
  writeLocalProviderAuth,
  type LocalProviderAuth,
  type LocalProviderCatalog,
} from "../src/opencode-v2-local-auth.js";
import { organizationProviderGate } from "../src/organization-provider-gate.js";

// Trimmed GET /provider answer from the bundled OpenCode v1.18.30 engine,
// recorded with an OpenRouter API key and a ChatGPT (OAuth) sign-in in its
// auth.json. Every value is the engine's own except the catalog's copy of the
// OpenRouter key, replaced with a marker that must never be used.
const fixturePath = new URL("./fixtures/opencode-v1.18.30-provider.json", import.meta.url);
const CATALOG_KEY = "sk-or-catalog-copy-must-not-be-used";
const KEY = "sk-or-local-test-key";

let providerReads = 0;
let fixtureCatalog = new Map<string, unknown>();
// The mirror reads built-in metadata from a catalog; this one serves the
// recorded engine answer (Provider.Info entries are still translated).
const catalog: LocalProviderCatalog = async () => {
  providerReads += 1;
  return fixtureCatalog;
};

before(async () => {
  const value: unknown = JSON.parse(await readFile(fixturePath, "utf8"));
  const all = value && typeof value === "object" && "all" in value && Array.isArray(value.all) ? value.all : [];
  fixtureCatalog = new Map(all.flatMap((provider: unknown) =>
    provider && typeof provider === "object" && "id" in provider && typeof provider.id === "string" ? [[provider.id, provider] as const] : []));
});

/** A nested value of a generated config, or undefined. */
function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = Object.entries(current).find(([name]) => name === key)?.[1];
  }
  return current;
}

const auth = (apiKeys: Record<string, string>, signIns: string[] = []): LocalProviderAuth => ({
  apiKeys: new Map(Object.entries(apiKeys)),
  signIns: new Set(signIns),
});

test("without a rollout or sign-in, the real v1.18.30 OpenRouter entry becomes one v2 provider with its models", async () => {
  const local = await localProviderDefinitions(catalog, auth({ openrouter: KEY }), {});
  const mapped = mapRuntimeProvidersToV2Specs(local.providers, new Map(), new Map([["openrouter", KEY]]));

  assert.deepEqual(local.skipped, []);
  assert.deepEqual(mapped.skippedProviders, []);
  assert.equal(mapped.specs.length, 1);
  const spec = mapped.specs[0];
  assert.equal(spec?.id, "openrouter");
  assert.equal(spec?.name, "OpenRouter");
  assert.equal(spec?.package, "@opencode/ai/providers/openrouter");
  assert.equal(spec?.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(spec?.apiKey, KEY, "the key comes from auth.json");
  assert.ok(!JSON.stringify(mapped).includes(CATALOG_KEY), "the catalog's copy of the key is never used");
  assert.equal(spec?.headers, undefined, "engine-specific catalog headers do not carry over");
  assert.equal(spec?.settings, undefined);
  assert.deepEqual(spec?.models.map(model => model.id), [
    "arcee-ai/trinity-large-thinking",
    "bytedance-seed/seed-1.6",
    "deepseek/deepseek-v4.1-flash",
    "scaledown/summarize",
  ]);

  const rendered = renderOpencodeV2Config({ providers: mapped.specs, skills: [] });
  const openrouter = (...path: string[]) => at(rendered, "providers", "openrouter", ...path);
  const model = (id: string, ...path: string[]) => openrouter("models", id, ...path);
  assert.equal(openrouter("package"), "@opencode/ai/providers/openrouter");
  assert.equal(openrouter("settings", "baseURL"), "https://openrouter.ai/api/v1");
  assert.equal(openrouter("settings", "apiKey"), KEY);
  assert.deepEqual(model("deepseek/deepseek-v4.1-flash", "capabilities"), { tools: true, input: ["text", "image"], output: ["text", "reasoning"] });
  assert.deepEqual(model("deepseek/deepseek-v4.1-flash", "limit"), { context: 1048576, output: 943718 });
  assert.deepEqual(model("deepseek/deepseek-v4.1-flash", "variants"), [
    { id: "none", settings: { reasoning: { effort: "none" } } },
    { id: "low", settings: { reasoning: { effort: "low" } } },
    { id: "high", settings: { reasoning: { effort: "high" } } },
    { id: "max", settings: { reasoning: { effort: "max" } } },
  ]);
  assert.equal(model("deepseek/deepseek-v4.1-flash", "modelID"), "deepseek/deepseek-v4.1-flash");
  assert.deepEqual(model("scaledown/summarize", "capabilities"), { tools: false, input: ["text", "image", "pdf"], output: ["text"] });
  assert.equal(model("bytedance-seed/seed-1.6", "disabled"), true, "a deprecated model stays out of the picker, as in v1");
});

test("an organization that allows only its own providers mirrors none of the keys added on this computer", async () => {
  const allows = organizationProviderGate({ allowCustomProviders: false });
  const reads = providerReads;
  const local = await localProviderDefinitions(catalog, auth({ openrouter: KEY, anthropic: "sk-ant-local" }, ["openai"]), {}, { allows });

  assert.deepEqual(local.providers, {});
  assert.deepEqual(local.skipped, [
    { id: "anthropic", reason: "policy" },
    { id: "openai", reason: "policy" },
    { id: "openrouter", reason: "policy" },
  ]);
  assert.equal(providerReads, reads, "blocked providers are not even looked up");
});

test("the organization rule matches the providers v1 keeps in enabled_providers", () => {
  const provider = Object.fromEntries(["lpr_team", "ipr_gateway", "openwork", "personal-byok", "openrouter"]
    .map(id => [id, { npm: "@ai-sdk/openai-compatible", models: {} }]));
  for (const managedPolicy of [{ allowCustomProviders: false }, { allowCustomProviders: false, allowZenModel: false }]) {
    const v1 = buildOpenworkRuntimeConfigObjectFromSnapshot({ provider, managedPolicy }).enabled_providers;
    assert.ok(Array.isArray(v1));
    const allows = organizationProviderGate(managedPolicy);
    assert.ok(allows);
    for (const id of [...Object.keys(provider), "opencode", "anthropic"]) {
      assert.equal(allows(id), v1.includes(id), `${id} with ${JSON.stringify(managedPolicy)}`);
    }
  }
  assert.equal(organizationProviderGate({ allowCustomProviders: true }), null);
  assert.equal(organizationProviderGate(undefined), null);
});

test("a ChatGPT-style sign-in is reported as skipped instead of disappearing", async () => {
  const local = await localProviderDefinitions(catalog, auth({}, ["openai"]), {});

  assert.deepEqual(local.providers, {});
  assert.deepEqual(local.skipped, [{ id: "openai", reason: "oauth" }]);
  assert.ok(!JSON.stringify(local).includes("opencode-oauth-dummy-key"));
});

test("providers without a usable v2 description are skipped with a reason", async () => {
  const keys = { google: "google-local", "github-copilot": "copilot-local", "not-in-catalog": "missing-local", anthropic: "sk-ant-local" };
  const local = await localProviderDefinitions(catalog, auth(keys), {});
  const mapped = mapRuntimeProvidersToV2Specs(local.providers, new Map(), new Map(Object.entries(keys)));

  // Mixed adapters in one provider, and a provider v1 does not describe.
  assert.deepEqual(local.skipped, [
    { id: "github-copilot", reason: "metadata" },
    { id: "not-in-catalog", reason: "metadata" },
  ]);
  // No built-in v2 adapter in the mirror for Google; Anthropic maps to its native one.
  assert.deepEqual(mapped.skippedProviders, [{ id: "google", reason: "unsupported" }]);
  assert.deepEqual(mapped.specs.map(spec => [spec.id, spec.package, spec.baseUrl ?? null]), [["anthropic", "@opencode/ai/providers/anthropic", null]]);
});

test("organization providers and configured providers are never read from the v1 catalog", async () => {
  const reads = providerReads;
  const local = await localProviderDefinitions(catalog, auth({ lpr_team: "managed", openwork: "managed", openrouter: KEY }), { openrouter: {} });

  assert.deepEqual(local, { providers: {}, skipped: [] });
  assert.equal(providerReads, reads);
});

test("the models.dev shape older engines answer with still maps", () => {
  const normalized = normalizeLocalProviderDefinition({
    id: "openrouter",
    name: "OpenRouter",
    npm: "@openrouter/ai-sdk-provider",
    api: "https://openrouter.ai/api/v1",
    env: ["OPENROUTER_API_KEY"],
    key: CATALOG_KEY,
    options: { apiKey: CATALOG_KEY, baseURL: "https://attacker.example.test/v1" },
    models: { "openai/gpt-4.1": { id: "openai/gpt-4.1", name: "GPT-4.1", tool_call: true, modalities: { input: ["text"], output: ["text"] } } },
  });
  assert.ok("definition" in normalized);
  const mapped = mapRuntimeProvidersToV2Specs({ openrouter: normalized.definition }, new Map(), new Map([["openrouter", KEY]]));

  assert.deepEqual(mapped.skippedProviderIds, []);
  assert.equal(mapped.specs[0]?.package, "@opencode/ai/providers/openrouter");
  assert.equal(mapped.specs[0]?.baseUrl, "https://openrouter.ai/api/v1", "a catalog baseURL never overrides the trusted endpoint");
  assert.equal(mapped.specs[0]?.apiKey, KEY);
  assert.deepEqual(mapped.specs[0]?.models.map(model => model.id), ["openai/gpt-4.1"]);
});

test("a catalog endpoint off the adapter's own origin is not trusted", () => {
  const normalized = normalizeLocalProviderDefinition({
    id: "openrouter",
    env: ["OPENROUTER_API_KEY"],
    models: { model: { id: "model", api: { id: "model", npm: "@openrouter/ai-sdk-provider", url: "https://relay.example.test/api/v1" } } },
  });
  assert.ok("definition" in normalized);
  const mapped = mapRuntimeProvidersToV2Specs({ openrouter: normalized.definition }, new Map(), new Map([["openrouter", KEY]]));

  assert.deepEqual(mapped.skippedProviders, [{ id: "openrouter", reason: "unsupported" }]);
});

test("auth.json API keys and sign-ins are told apart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-local-auth-"));
  try {
    const path = join(directory, "auth.json");
    await writeFile(path, JSON.stringify({
      openrouter: { type: "api", key: KEY },
      anthropic: { type: "api", key: "  " },
      openai: { type: "oauth", refresh: "refresh", access: "access", expires: 1 },
      enterprise: { type: "wellknown", key: "token", token: "token" },
      broken: "not an entry",
    }));
    const read = await readLocalProviderAuth(path);
    assert.deepEqual([...read.apiKeys], [["openrouter", KEY]]);
    assert.deepEqual([...read.signIns].sort(), ["enterprise", "openai"]);
    assert.deepEqual(await readLocalProviderAuth(join(directory, "missing.json")), { apiKeys: new Map(), signIns: new Set() });
    await writeFile(path, `invalid-json-${KEY}`);
    await assert.rejects(readLocalProviderAuth(path), { message: "Could not read local provider credentials" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("API keys saved on this computer keep every other credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-local-auth-write-"));
  const path = join(directory, "opencode", "auth.json");
  try {
    await writeLocalProviderAuth("openrouter", { type: "api", key: KEY }, path);
    await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), openai: { type: "oauth", refresh: "kept" } }));
    await writeLocalProviderAuth("anthropic", { type: "api", key: "sk-ant-local" }, path);
    await writeLocalProviderAuth("openrouter", null, path);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      openai: { type: "oauth", refresh: "kept" },
      anthropic: { type: "api", key: "sk-ant-local" },
    });
    const read = await readLocalProviderAuth(path);
    assert.deepEqual([...read.apiKeys], [["anthropic", "sk-ant-local"]]);
    await assert.rejects(writeLocalProviderAuth("lpr_team", { type: "api", key: "x" }, path), /organization/);
    await writeFile(path, "not json");
    await assert.rejects(writeLocalProviderAuth("anthropic", null, path), /could not read/i);
    assert.equal(await readFile(path, "utf8"), "not json", "an unreadable file is never replaced");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the provider catalog comes from the model catalog and falls back to its saved copy offline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-local-catalog-"));
  const cachePath = join(directory, "models-catalog.json");
  const body = JSON.stringify({ openrouter: { id: "openrouter", name: "OpenRouter", npm: "@openrouter/ai-sdk-provider", env: ["OPENROUTER_API_KEY"], models: {} } });
  const requested: string[] = [];
  try {
    const online = createLocalProviderCatalog({ cachePath, env: { OPENCODE_MODELS_URL: "https://models.example.test/", XDG_CACHE_HOME: join(directory, "cache") },
      fetch: async (url) => { requested.push(String(url)); return new Response(body); } });
    assert.deepEqual([...(await online()).keys()], ["openrouter"]);
    assert.deepEqual(requested, ["https://models.example.test/api.json"]);
    const offline = createLocalProviderCatalog({ cachePath, env: { OPENCODE_MODELS_URL: "https://models.example.test/", XDG_CACHE_HOME: join(directory, "cache") },
      fetch: async () => { throw new Error("offline"); } });
    assert.deepEqual([...(await offline()).keys()], ["openrouter"]);
    const empty = createLocalProviderCatalog({ cachePath: join(directory, "missing.json"), env: { OPENCODE_DISABLE_MODELS_FETCH: "1", HOME: directory, XDG_CACHE_HOME: join(directory, "cache") } });
    assert.equal((await empty()).size, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
