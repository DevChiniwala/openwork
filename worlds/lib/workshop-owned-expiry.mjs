#!/usr/bin/env node
/** Event-bound cleanup of this receipt's NEW replicas and NEW software snapshot only.
 * Never touches the shared Den/pilot, Windows, another stage or maintained bases.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
const [path] = process.argv.slice(2);
const initial = JSON.parse(readFileSync(path, "utf8"));
const deadline = Date.parse(initial.replication.deadline);
assert(Number.isFinite(deadline));
assert(initial.templateBuild?.snapshotName?.startsWith("ww-parallel-software-"));
assert(initial.templateBuild?.snapshotId && initial.replication.template.snapshotId === initial.templateBuild.snapshotId);
assert(process.env.DAYTONA_API_KEY && process.env.DAYTONA_API_URL === "https://app.daytona.io/api");
const headers = { authorization: `Bearer ${process.env.DAYTONA_API_KEY}` };
const update = f => { const r = JSON.parse(readFileSync(path, "utf8")); f(r); writeFileSync(path, JSON.stringify(r, null, 2)); };
update(r => { r.ownedExpiry = { scheduledAt: new Date().toISOString(), at: new Date(deadline).toISOString(), scope: "new replication seats and owned software snapshot only", state: "scheduled" }; });
setTimeout(async () => {
  try {
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    if (receipt.eventRenewalAuthorized === true && Date.parse(receipt.replication.deadline) > deadline) {
      update(r => { r.ownedExpiry.state = "cancelled-by-explicit-event-renewal"; }); return;
    }
    const deleted = [];
    for (const seat of receipt.replication.seats) {
      const url = `https://app.daytona.io/api/sandbox/${seat.id}`;
      const check = await fetch(url, { headers });
      if (check.status === 404) { deleted.push({ id: seat.id, state: "already-expired" }); continue; }
      assert(check.ok); const sandbox = await check.json();
      assert.equal(sandbox.labels?.["ww-parallel-stage"], receipt.stage);
      assert.equal(sandbox.labels?.["ww-parallel-seat"], String(seat.number));
      const result = await fetch(url, { method: "DELETE", headers });
      assert(result.ok || result.status === 404, "Owned replica cleanup failed");
      deleted.push({ id: seat.id, state: "delete-requested" });
    }
    const snapshotUrl = `https://app.daytona.io/api/snapshots/${receipt.templateBuild.snapshotId}`;
    const check = await fetch(`https://app.daytona.io/api/snapshots/${receipt.templateBuild.snapshotName}`, { headers });
    let snapshotState = "already-removed";
    if (check.status !== 404) {
      assert(check.ok); const snapshot = await check.json();
      assert.equal(snapshot.id, receipt.templateBuild.snapshotId);
      assert.equal(snapshot.name, receipt.templateBuild.snapshotName);
      const result = await fetch(snapshotUrl, { method: "DELETE", headers });
      assert(result.ok || result.status === 404, "Owned software snapshot cleanup failed"); snapshotState = "delete-requested";
    }
    update(r => { r.ownedExpiry = { ...r.ownedExpiry, state: "cleanup-requested", replicas: deleted, snapshot: snapshotState, completedAt: new Date().toISOString() }; });
    console.log("Owned event replicas/template cleanup requested; Den, pilot and Windows untouched.");
  } catch (error) {
    update(r => { r.ownedExpiry.state = "cleanup-failed-needs-owner"; r.ownedExpiry.error = String(error.message).replace(/https?:\/\/[^\s]+/g, "[url]").slice(0,300); });
    process.exitCode = 1; console.error("Owned expiry cleanup failed; inspect private receipt (no unrelated resources changed).");
  }
}, Math.max(0, deadline - Date.now()));
