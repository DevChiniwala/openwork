import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../workflows/pr-proof.yml", import.meta.url), "utf8");
const step = workflow.split("      - name: Select proof records from this workflow run\n")[1]?.split("\n      - name:")[0];
const script = step?.split("          script: |\n")[1]?.split("\n").map(line => line.slice(12)).join("\n");
assert.ok(script, "The evidence artifact selector must be present in the workflow");
const execute = new (Object.getPrototypeOf(async function () {}).constructor)("github", "context", "core", "process", script);
const key = "a".repeat(64);
const name = attempt => `pr-proof-${attempt}-${key}`;
async function select(artifacts, attempt = 2, suppliedKey = key) {
  const outputs = {};
  await execute({ rest: { actions: { listWorkflowRunArtifacts() {} } }, paginate: async (_method, input) => {
    assert.deepEqual(input, { owner: "example", repo: "repo", run_id: 42, per_page: 100 });
    return artifacts;
  } }, { repo: { owner: "example", repo: "repo" }, runId: 42 }, { setOutput: (key, value) => { outputs[key] = value; } },
  { env: { PROOF_KEY: suppliedKey, GITHUB_RUN_ATTEMPT: String(attempt) } });
  return outputs.name;
}

test("failed-only retries can judge passing evidence retained from an earlier attempt", async () => {
  assert.equal(await select([{ name: name(1), expired: false }, { name: `pr-proof-2-${"b".repeat(64)}`, expired: false }]), name(1));
  assert.equal(await select([{ name: name(1) }, { name: name(2) }]), name(2));
});

test("missing, duplicate, expired, future and invalid proof identities fail closed", async () => {
  for (const artifacts of [[], [{ name: name(2) }, { name: name(2) }], [{ name: name(1) }, { name: name(2), expired: true }], [{ name: name(3) }]]) {
    await assert.rejects(select(artifacts));
  }
  await assert.rejects(select([{ name: name(1) }], 2, "../other"));
  await assert.rejects(select([{ name: name(1) }], 0));
});
