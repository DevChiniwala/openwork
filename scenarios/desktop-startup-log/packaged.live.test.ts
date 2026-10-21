import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "@openwork/testkit";

// Named-only proof: capture the actual packaged launch log plus non-admin RDP
// provenance, and retain its ASAR. This does not pretend to build/sign Windows.
const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const asar = require("@electron/asar");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("a real non-admin packaged Windows launch records and attributes the synchronous plugin extraction stall", () => {
  const directory = process.env.OPENWORK_STARTUP_LOG_PROOF_DIR;
  assert.ok(directory, "Set OPENWORK_STARTUP_LOG_PROOF_DIR to a captured packaged launch (windows-startup.log, windows-provenance.json, candidate.asar)");
  const provenance = JSON.parse(readFileSync(join(directory, "windows-provenance.json"), "utf8"));
  assert.equal(provenance.platform, "win32");
  assert.equal(provenance.activeRdp, true);
  assert.equal(provenance.isAdmin, false);
  assert.ok(provenance.processes.length > 0);
  assert.ok(provenance.processes.every((entry: { session: number; owner: string }) => entry.session > 0 && entry.owner.startsWith("exp-spl-")));
  const archive = join(directory, "candidate.asar");
  assert.equal(digest(readFileSync(archive)), provenance.asarSha256.toLowerCase());
  for (const file of ["main.mjs", "runtime.mjs", "startup-log.mjs", "windows-shortcut.mjs"]) {
    assert.equal(digest(asar.extractFile(archive, `electron/${file}`)), digest(readFileSync(new URL(`../../apps/desktop/electron/${file}`, import.meta.url))), `packaged ${file} must be this tree`);
  }
  for (const file of ["startup-phase.js", "selfhost-web.js", "managed-opencode.js", "managed-opencode-v2.js", "engine-v2-preview.js"]) {
    assert.equal(digest(asar.extractFile(archive, `server/dist/${file}`)), digest(readFileSync(new URL(`../../apps/server/dist/${file}`, import.meta.url))), `packaged ${file} must be this compiled tree`);
  }
  const text = readFileSync(join(directory, "windows-startup.log"), "utf8");
  assert.equal(/https?:\/\/|[A-Z]:\\\\Users\\\\|Bearer |token|password|prompt/i.test(text), false);
  const rows = text.trim().split("\n").map((line) => JSON.parse(line));
  for (const phase of ["app.ready", "window.create", "window.show", "runtime.start", "server.start", "engine.v1.resolve", "engine.version-probe", "engine.v1.serve", "engine.v2.resolve", "engine.v2.version-probe", "engine.v2.serve", "plugin-deps.seed", "plugin-deps.extract", "ca.bundle", "windows.shortcut"]) {
    assert.ok(rows.some((row) => row.event === "start" && row.phase === phase), `${phase} starts`);
    assert.ok(rows.some((row) => row.event === "end" && row.phase === phase && row.durationMs >= 0), `${phase} finishes`);
  }
  const stall = rows.find((row) => row.event === "stall" && row.lateMs > 2000 && row.open.some((entry: { phase: string }) => entry.phase === "plugin-deps.extract"));
  assert.ok(stall, "actual extraction must be attributed, not merely an arbitrary timer delay");
  const extraction = stall.open.find((entry: { phase: string }) => entry.phase === "plugin-deps.extract");
  const endIndex = rows.findIndex((row) => row.event === "end" && row.id === extraction.id);
  assert.ok(endIndex > rows.indexOf(stall), "attribution survives synchronous completion before timer dispatch");
  assert.ok(rows[endIndex].durationMs >= 2000);
  assert.ok(rows.some((row) => row.event === "end" && row.phase === "runtime.start" && row.status === "ok"), "runtime recovered after the stall");
});
