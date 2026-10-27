import assert from "node:assert/strict";
import { test } from "node:test";
import { engineV2UpkeepWarning } from "../src/engine-v2-upkeep-warning.js";

const at = new Date("2026-01-01T00:00:00.000Z");
const timestamp = at.toISOString();

for (const directory of ["/Users/synthetic/private-workspace", "C:\\Users\\synthetic\\private-workspace", "relative/private-workspace"]) {
  test(`provider catalog timeout status does not expose ${directory}`, () => {
    const warning = engineV2UpkeepWarning(`Providers: ${directory} did not list every mirrored provider in time; serving the engine's catalog`, at);
    assert.equal(warning, `${timestamp} Provider catalog refresh did not finish in time; serving the engine's catalog.`);
    assert.ok(!warning.includes(directory));
  });
}

test("all upkeep failure kinds expose only fixed summaries, never raw diagnostics", () => {
  const privateDetail = "/private/synthetic/workspace: upstream body with Bearer synthetic-secret\nC:\\private\\workspace";
  const cases = [
    { message: `MCP synthetic-server: ${privateDetail}`, summary: "An MCP connection needs upkeep; requests can continue." },
    { message: `MCP: ${privateDetail}`, summary: "An MCP connection needs upkeep; requests can continue." },
    { message: `History copy state: ${privateDetail}`, summary: "History copy progress could not be saved." },
    { message: `History copy: ${privateDetail}`, summary: "History copy needs attention." },
    { message: `Unknown future upkeep step: ${privateDetail}`, summary: "Engine upkeep needs attention; requests can continue." },
  ];
  for (const { message, summary } of cases) {
    const warning = engineV2UpkeepWarning(message, at);
    assert.equal(warning, `${timestamp} ${summary}`);
    assert.ok(!warning.includes(privateDetail));
    assert.ok(!warning.includes("synthetic-secret"));
  }
});

test("upkeep summaries retain a timestamp without retaining dynamic MCP names or errors", () => {
  const before = Date.now();
  const warning = engineV2UpkeepWarning("MCP /private/synthetic/server: registration failed (500)");
  const after = Date.now();
  const time = Date.parse(warning.slice(0, 24));
  assert.ok(time >= before && time <= after);
  assert.equal(warning.slice(25), "An MCP connection needs upkeep; requests can continue.");
});
