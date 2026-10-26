import { expect, test } from "vitest";
import { summarizeEngineLog } from "../src/engine-output.js";

test("an engine startup timeout shows how far each OpenCode run got and its latest problems", () => {
  const watcherLines = Array.from({ length: 200 }, (_, index) =>
    `timestamp=2026-10-26T19:47:50.${String(index).padStart(3, "0")}Z level=INFO run=0e32f78b message="watcher started" path=/repo role=server`);
  const log = [
    "timestamp=2026-10-26T19:47:50.000Z level=INFO run=0e32f78b message=\"database schema bootstrap started\" role=server",
    ...watcherLines,
    "timestamp=2026-10-26T19:47:50.714Z level=INFO run=3d5a1cd5 message=loading path=/config/opencode/config.json",
    "timestamp=2026-10-26T19:47:50.725Z level=WARN run=3d5a1cd5 message=\"install retry\" registry=https://registry.example token=secret-123",
    "",
  ].join("\n");
  expect(summarizeEngineLog("/data/opencode/log/opencode.log", log, ["secret-123"]).split("\n")).toEqual([
    "OpenCode log since launch (/data/opencode/log/opencode.log):",
    "run=0e32f78b: 201 lines from 2026-10-26T19:47:50.000Z; last: timestamp=2026-10-26T19:47:50.199Z level=INFO message=\"watcher started\" path=/repo role=server",
    "run=3d5a1cd5: 2 lines from 2026-10-26T19:47:50.714Z; last: timestamp=2026-10-26T19:47:50.725Z level=WARN message=\"install retry\" registry=https://registry.example token=<redacted>",
    "problem in run=3d5a1cd5: timestamp=2026-10-26T19:47:50.725Z level=WARN message=\"install retry\" registry=https://registry.example token=<redacted>",
  ]);
});

test("an engine that wrote nothing says so instead of printing an empty section", () => {
  expect(summarizeEngineLog("/data/opencode/log/opencode.log", "\n")).toBe("OpenCode log: nothing written to /data/opencode/log/opencode.log since launch");
});
