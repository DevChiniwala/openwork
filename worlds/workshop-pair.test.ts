import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { forEachSeat, isProviderThrottle, pairInfrastructureUsd, parsePairOptions, retryThrottled, seatKey } from "./workshop-pair.ts";
import { capacityShortfall, assertDaytonaCapacity } from "./lib/workshop-capacity.ts";
import { assertTrustedWorkshopRef } from "./lib/workshop-trust.ts";

const out = "/private/var/workshop-pair-fixture";
const repo = fileURLToPath(new URL("..", import.meta.url));

test("seat count is one flag from 1 to 99, with stable two-digit names", () => {
  assert.equal(parsePairOptions(["--output-dir", out]).seats, 1);
  assert.equal(parsePairOptions(["--output-dir", out, "--seats", "50"]).seats, 50);
  assert.equal(parsePairOptions(["--output-dir", out, "--seats", "99"]).seats, 99);
  for (const bad of ["0", "100", "2.5", "-3", "twenty"]) assert.throws(() => parsePairOptions(["--output-dir", out, "--seats", bad]));
  assert.equal(seatKey(1), "attendee01");
  assert.equal(seatKey(99), "attendee99");
  assert.throws(() => seatKey(100));
});

test("infrastructure estimate scales with seats and is checked against an explicit budget", () => {
  assert.ok(pairInfrastructureUsd(360, 50) > pairInfrastructureUsd(360, 20));
  assert.equal(parsePairOptions(["--output-dir", out]).budgetUsd, 200);
  assert.equal(parsePairOptions(["--output-dir", out, "--budget-usd", "350"]).budgetUsd, 350);
  assert.throws(() => parsePairOptions(["--output-dir", out, "--budget-usd", "0"]));
  // 50 seats for 6 hours fits the default budget; 99 seats for 24 hours does not.
  assert.ok(pairInfrastructureUsd(360, 50) < 200);
  assert.ok(pairInfrastructureUsd(1440, 99) > 200);
});

test("quota preflight names how many seats fit before anything is created", async () => {
  const usage = { totalCpuQuota: 250, totalMemoryQuota: 500, totalDiskQuota: 2000, currentCpuUsage: 212, currentMemoryUsage: 424, currentDiskUsage: 530 };
  assert.match(capacityShortfall(usage, 26) ?? "", /fits 9 more workshop sandbox\(es\) but this launch needs 26 \(1 Den \+ 25 seats\)/);
  assert.equal(capacityShortfall({ ...usage, currentCpuUsage: 0, currentMemoryUsage: 0, currentDiskUsage: 0 }, 51), null);
  const previous = process.env.DAYTONA_API_KEY;
  process.env.DAYTONA_API_KEY = "test-key";
  try {
    const reply = (body: unknown) => async () => Response.json(body);
    await assert.rejects(assertDaytonaCapacity(26, reply({ regionUsage: [{ regionId: "us", sandboxClass: "container", ...usage }] })), /needs 26/);
    await assertDaytonaCapacity(5, reply({ regionUsage: [{ regionId: "us", sandboxClass: "container", ...usage }] }));
    await assert.rejects(assertDaytonaCapacity(5, reply({ regionUsage: [] })), /did not report container quota/);
  } finally { if (previous === undefined) delete process.env.DAYTONA_API_KEY; else process.env.DAYTONA_API_KEY = previous; }
});

test("one failed seat never stops the others, and only provider throttling is retried", async () => {
  const results = await forEachSeat(30, 10, async (index) => { if (index % 7 === 0) throw new Error(`seat ${index}`); return index; });
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 26);
  assert.ok(isProviderThrottle(new Error('level=fatal msg="Too Many Requests: ThrottlerException"')));
  assert.ok(!isProviderThrottle(new Error("snapshot missing")));
  let calls = 0;
  await assert.rejects(retryThrottled(async () => { calls++; throw new Error("snapshot missing"); }, 5, 1), /snapshot missing/);
  assert.equal(calls, 1);
});

test("attendees are only signed in to source already merged into dev", async () => {
  const merged = execFileSync("git", ["rev-parse", "origin/dev"], { cwd: repo, encoding: "utf8" }).trim();
  await assertTrustedWorkshopRef(merged, repo);
  const unmerged = execFileSync("git", ["commit-tree", "-m", "untrusted", `${merged}^{tree}`], { cwd: repo, encoding: "utf8" }).trim();
  await assert.rejects(assertTrustedWorkshopRef(unmerged, repo), /not merged into origin\/dev/);
  await assert.rejects(assertTrustedWorkshopRef("dev", repo), /full commit SHA/);
});
