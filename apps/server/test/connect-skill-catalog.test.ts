import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readOpenWorkConnectSkillContent, resetOpenWorkConnectSkillCatalogCacheForTests } from "../src/connect-skill-catalog.js";
import { writeConnectCloudMcp } from "../src/connect-state.js";
import type { ServerConfig } from "../src/types.js";

const digest = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const crmBody = "---\nname: crm-sync\ndescription: \"Sync the CRM.\"\n---\n\nUpdate Notion.";
const crmUrl = "skill://crm-sync/SKILL.md";
const tamperedUrl = "skill://tampered/SKILL.md";

/** A minimal openwork-cloud MCP that serves one index and counts SKILL.md reads. */
function fakeDen(index: { skills: Array<Record<string, unknown>> }) {
  const reads: string[] = [];
  const fetcher = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const uri: string = body.params.uri;
    const text = uri === "skill://index.json"
      ? JSON.stringify({ $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json", delivery: "native", ...index })
      : (reads.push(uri), uri === crmUrl ? crmBody : "not the published body");
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { contents: [{ uri, text }] } });
  };
  return { reads, fetcher };
}

function skill(name: string, url: string, body: string) {
  return { name, type: "skill-md", description: name, url, capability: `skill:${name}`, digest: digest(body) };
}

describe("readOpenWorkConnectSkillContent", () => {
  let dir: string;
  let config: ServerConfig;
  const previousDb = process.env.OPENWORK_RUNTIME_DB;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "openwork-skill-catalog-"));
    process.env.OPENWORK_RUNTIME_DB = join(dir, "runtime.sqlite");
    config = {
      host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(dir, "server.json"),
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
      startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    };
    await writeConnectCloudMcp(config, { type: "remote", url: "https://den.test/mcp/agent" });
    resetOpenWorkConnectSkillCatalogCacheForTests();
  });

  afterEach(() => {
    resetOpenWorkConnectSkillCatalogCacheForTests();
    if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousDb;
    rmSync(dir, { recursive: true, force: true });
  });

  test("every body it serves comes from a read Den authorized", async () => {
    const den = fakeDen({ skills: [skill("crm-sync", crmUrl, crmBody)] });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await readOpenWorkConnectSkillContent(config, crmUrl, den.fetcher)).toBe(crmBody);
    }
    expect(den.reads).toEqual([crmUrl, crmUrl, crmUrl]);
  });

  test("does not re-read a body that failed its digest on every refresh", async () => {
    const den = fakeDen({ skills: [skill("tampered", tamperedUrl, "the published body")] });
    expect(await readOpenWorkConnectSkillContent(config, tamperedUrl, den.fetcher)).toBe("not the published body");
    expect(await readOpenWorkConnectSkillContent(config, tamperedUrl, den.fetcher)).toBeNull();
    expect(den.reads).toEqual([tamperedUrl]);
    // After ten minutes it is read again.
    setSystemTime(new Date(Date.now() + 10 * 60_000 + 1_000));
    try {
      await readOpenWorkConnectSkillContent(config, tamperedUrl, den.fetcher);
      expect(den.reads).toEqual([tamperedUrl, tamperedUrl]);
    } finally {
      setSystemTime();
    }
  });

  test("returns nothing once Den stops listing the skill", async () => {
    const den = fakeDen({ skills: [skill("crm-sync", crmUrl, crmBody)] });
    expect(await readOpenWorkConnectSkillContent(config, crmUrl, den.fetcher)).toBe(crmBody);
    // The next index read, once the 30 s catalog cache expires, no longer lists it.
    setSystemTime(new Date(Date.now() + 31_000));
    try {
      const revoked = fakeDen({ skills: [] });
      expect(await readOpenWorkConnectSkillContent(config, crmUrl, revoked.fetcher)).toBeNull();
      expect(revoked.reads).toEqual([]);
    } finally {
      setSystemTime();
    }
  });
});
