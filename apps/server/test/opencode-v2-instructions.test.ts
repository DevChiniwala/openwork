import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOpenWorkV2Instructions } from "../src/opencode-v2-instructions.js";

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
