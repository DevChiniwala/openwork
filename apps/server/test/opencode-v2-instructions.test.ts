import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildOpenWorkV2Instructions, readConfiguredInstructions } from "../src/opencode-v2-instructions.js";

test("V2 instructions support both individual Connect tools and capability search", () => {
  const instructions = buildOpenWorkV2Instructions(true);
  for (const text of [instructions.operatingInstructions, instructions.connect]) {
    assert.match(text, /search\(\) to discover available tools/);
    assert.match(text, /individual service tools, call them directly/);
    assert.match(text, /When it exposes search_capabilities and execute_capability instead/);
    assert.doesNotMatch(text, /bare search\(\) function only for other/);
    assert.doesNotMatch(text, /discover services and Workflows with openwork-cloud\.search_capabilities/);
  }
});

test("V2 instructions do not claim Connect is available when disconnected", () => {
  assert.equal(buildOpenWorkV2Instructions(false).connect,
    "OpenWork Connect is not connected for this request. Do not claim remote capabilities are available.");
});

test("configured instructions load workspace files the engine skips", async () => {
  const base = await mkdtemp(join(tmpdir(), "openwork-configured-instructions-"));
  try {
    const workspace = join(base, "workspace");
    await mkdir(join(workspace, ".opencode"), { recursive: true });
    await mkdir(join(workspace, "rules"));
    await writeFile(join(base, "outside.md"), "outside rules");
    await writeFile(join(workspace, ".opencode", "AGENTS.md"), "project rules");
    await writeFile(join(workspace, "rules", "b.md"), "rule b");
    await writeFile(join(workspace, "rules", "a.md"), "rule a");
    await symlink(join(base, "outside.md"), join(workspace, "rules", "c.md"));
    await writeFile(join(workspace, "opencode.jsonc"), `{
      // Same file twice, a glob, paths outside the workspace and a URL.
      "instructions": [".opencode/AGENTS.md", "rules/*.md", "../outside.md", "${join(base, "outside.md")}", "https://example.com/rules.md"],
    }`);
    await writeFile(join(workspace, ".opencode", "opencode.json"), JSON.stringify({ instructions: [".opencode/AGENTS.md"] }));

    assert.equal(await readConfiguredInstructions(workspace), [
      `Instructions from: ${join(workspace, ".opencode", "AGENTS.md")}\nproject rules`,
      `Instructions from: ${join(workspace, "rules", "a.md")}\nrule a`,
      `Instructions from: ${join(workspace, "rules", "b.md")}\nrule b`,
    ].join("\n\n"));

    await writeFile(join(workspace, "opencode.jsonc"), "{}");
    await rm(join(workspace, ".opencode", "opencode.json"));
    assert.equal(await readConfiguredInstructions(workspace), null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
