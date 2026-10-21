import assert from "node:assert/strict";
import { test } from "node:test";
import { availableWorkshopModel } from "./workshop-models.ts";

test("only the exact available managed alias is accepted; free fallback and duplicate aliases fail closed", () => {
  const model = { modelId: "workshop-alias", providerId: "openwork_gateway_fixture", displayName: "Workshop Sol", available: true };
  assert.deepEqual(availableWorkshopModel({ models: [model] }, "workshop-alias"), { providerId: model.providerId, modelId: model.modelId, displayName: model.displayName });
  assert.throws(() => availableWorkshopModel({ models: [{ ...model, modelId: "big-pickle" }] }, "workshop-alias"));
  assert.throws(() => availableWorkshopModel({ models: [{ ...model, available: false }] }, "workshop-alias"));
  assert.throws(() => availableWorkshopModel({ models: [model, model] }, "workshop-alias"));
});
