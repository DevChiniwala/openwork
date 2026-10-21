import assert from "node:assert/strict";
import { test } from "node:test";
import { startWorkshop } from "../../evals/packages/open-workplace/src/workshop.mjs";
import { newResetToken, nodeSupportsGateway, parseSignedPreviewOrigin, probeAutomaticJoin, probeGatewayHealth, startDaytonaGateway } from "./workshop-gateway.ts";
import { provisionWorkshopModel } from "./workshop-model.ts";
import {
  allocateDesktops, attendeeKeys, DAYTONA_MAX_LIFETIME_MINUTES, parseWorkshopArgs, PreflightError, redact, remainingWorkshopLifetimeMs, resetCommand, runPreflight, workshopOutputs,
} from "./workshop-plan.ts";
import type { WorkshopOutputInput } from "./workshop-plan.ts";
import { parseArgs as parseResetArgs, readWorldOutputs } from "./workshop-reset.ts";

const quiet = () => undefined;

test("arguments: backend-only default, explicit count, strict validation", () => {
  assert.deepEqual(parseWorkshopArgs([], "daytona"), { count: 0, lifetimeMinutes: 720, allowanceUsd: "5", model: "gpt-6.1-sol", concurrency: 2 });
  assert.equal(parseWorkshopArgs(["--count", "0"], "daytona").count, 0);
  const parsed = parseWorkshopArgs(["--count", "30", "--allowance-usd", "2.50", "--lifetime", "240", "--concurrency", "3"], "daytona");
  assert.deepEqual([parsed.count, parsed.allowanceUsd, parsed.lifetimeMinutes, parsed.concurrency], [30, "2.50", 240, 3]);
  // No artificial attendee ceiling beyond "is a number".
  assert.equal(parseWorkshopArgs(["--count", "250"], "daytona").count, 250);
  for (const argv of [["--count"], ["--count", "-1"], ["--count", "2", "--count", "3"], ["--seats", "2"], ["--allowance-usd", "1.1234567"], ["--concurrency", "9"], ["--model", "a b"]]) {
    assert.throws(() => parseWorkshopArgs(argv, "local"), /--count/);
  }
  // Signed Daytona preview links last 24h, so a remote world cannot outlive them.
  assert.throws(() => parseWorkshopArgs(["--lifetime", "0"], "daytona"), /24 hours/);
  assert.throws(() => parseWorkshopArgs(["--lifetime", String(DAYTONA_MAX_LIFETIME_MINUTES + 1)], "daytona"), /24 hours/);
  assert.equal(parseWorkshopArgs(["--lifetime", "0"], "local").lifetimeMinutes, 0);
});

test("event lifetime includes provisioning time and never silently restarts after boot", () => {
  const expires = new Date(120 * 60_000);
  assert.equal(remainingWorkshopLifetimeMs(expires, 5 * 60_000), 115 * 60_000);
  assert.equal(remainingWorkshopLifetimeMs(expires, 121 * 60_000), 1);
});

test("attendee keys are distinct, ordered and never prefix one another", () => {
  assert.deepEqual(attendeeKeys(0), []);
  assert.deepEqual(attendeeKeys(3), ["attendee-01", "attendee-02", "attendee-03"]);
  const many = attendeeKeys(120);
  assert.equal(many[0], "attendee-001");
  assert.equal(new Set(many).size, 120);
  for (const a of many) for (const b of many) if (a !== b) assert.ok(!b.startsWith(a));
});

test("preflight runs in order and stops at the first failure without leaking secrets", async () => {
  const ran: string[] = [];
  const secretValue = "super-secret-password-123";
  const step = (id: string, fail = false) => ({ id, label: id, run: async () => { ran.push(id); if (fail) throw new Error(`boom with ${secretValue}`); } });
  await assert.rejects(
    runPreflight([step("den"), step("gateway"), step("join", true), step("connections")], { secrets: [secretValue], log: quiet }),
    (error: unknown) => error instanceof PreflightError && error.step === "join" && !error.message.includes(secretValue) && /No attendee desktops/.test(error.message),
  );
  assert.deepEqual(ran, ["den", "gateway", "join"]);
  ran.length = 0;
  const passed = await runPreflight([step("den"), step("gateway")], { log: quiet });
  assert.deepEqual(passed.map((entry) => entry.id), ["den", "gateway"]);
});

test("desktops: a failed pilot stops everything before any other desktop starts", async () => {
  const launched: string[] = [];
  await assert.rejects(allocateDesktops(attendeeKeys(4), async (key) => { launched.push(key); throw new Error("no snapshot"); }, { concurrency: 2, log: quiet }), /Pilot desktop attendee-01/);
  assert.deepEqual(launched, ["attendee-01"]);
  assert.deepEqual(await allocateDesktops([], async () => 1, { concurrency: 2, log: quiet }), []);
});

test("desktops: pilot first, then bounded concurrency, one retry, failures reported not fatal", async () => {
  const order: string[] = [];
  let active = 0;
  let peak = 0;
  const attempts = new Map<string, number>();
  const results = await allocateDesktops(attendeeKeys(6), async (key, attempt) => {
    order.push(key);
    attempts.set(key, attempt);
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    if (key === "attendee-03" && attempt === 1) throw new Error("transient");
    if (key === "attendee-05") throw new Error("always fails token=abcdef123456");
    return `viewer-${key}`;
  }, { concurrency: 2, secrets: ["abcdef123456"], log: quiet });
  assert.equal(order[0], "attendee-01");
  assert.ok(peak <= 2);
  assert.equal(attempts.get("attendee-03"), 2);
  assert.deepEqual(results.map((result) => [result.key, result.ok]), [
    ["attendee-01", true], ["attendee-02", true], ["attendee-03", true], ["attendee-04", true], ["attendee-05", false], ["attendee-06", true],
  ]);
  const failed = results.find((result) => !result.ok);
  assert.ok(failed && !failed.ok && !failed.error.includes("abcdef123456"));
});

test("outputs: credentials and viewer links are secrets, grouped per attendee, with the exact reset command", () => {
  const input: WorkshopOutputInput = {
    place: "daytona", stage: "acme-oct", denWebUrl: "https://3005-den.example", denApiUrl: "https://8788-den.example", aiGatewayUrl: "https://8791-den.example",
    workplaceUrl: "https://3994-den.example", resetToken: "reset-token-value-xxxxxxxxxxxxxxxxxxxxxx", admin: { email: "host@example.test", password: "host-password" },
    orgName: "Workshop acme-oct", connections: [{ app: "outlook", id: "c1" }], model: { state: "skipped", note: "No OPENAI_API_KEY" },
    attendees: [
      { key: "attendee-01", email: "a1@example.test", password: "pw-one", ok: true, viewerUrl: "https://6080-d1.example/?autoconnect=1", sandbox: "d1" },
      { key: "attendee-02", email: "a2@example.test", password: "pw-two", ok: false, error: "display gate failed" },
    ],
    denSandbox: "den-1", expires: new Date("2026-10-21T00:00:00Z"),
  };
  const outputs = workshopOutputs(input);
  const entry = (key: string) => { const value = outputs[key]; assert.ok(value && typeof value !== "string", key); return value; };
  for (const key of ["adminPassword", "resetToken", "attendee01Password", "attendee01Viewer", "attendee02Password"]) assert.equal(entry(key).secret, true, key);
  for (const key of ["denWeb", "workplace", "reset", "adminEmail", "attendee01Email"]) assert.notEqual(entry(key).secret, true, key);
  assert.equal(entry("attendee01Viewer").group, "Attendee 01");
  assert.equal(entry("attendee02Status").value, "failed");
  assert.equal(entry("reset").value, "node worlds/lib/workshop-reset.ts --stage acme-oct --confirm");
  assert.equal(resetCommand(undefined), "node worlds/lib/workshop-reset.ts --confirm");
  assert.equal(entry("attendeeReset").value, "https://3994-den.example/_workshop/reset");
  const publicText = JSON.stringify(Object.values(outputs).filter((value) => typeof value === "string" || !value.secret));
  for (const hidden of ["host-password", "reset-token-value", "pw-one", "pw-two", "6080-d1"]) assert.ok(!publicText.includes(hidden), hidden);
  assert.equal(entry("attendees").note?.includes("1 desktop(s) failed"), true);
});

test("redaction covers plain, URL-encoded and base64 forms", () => {
  const value = "p@ss/word+=1234";
  const text = `a ${value} b ${encodeURIComponent(value)} c ${Buffer.from(value).toString("base64")}`;
  assert.equal(redact(text, [value, undefined]), "a [redacted] b [redacted] c [redacted]");
});

test("gateway helpers: preview origin shape, Node floor, reset key format", () => {
  assert.equal(parseSignedPreviewOrigin("time=x\nhttps://3994-abcdef123.proxy.daytona.works\n", 3994), "https://3994-abcdef123.proxy.daytona.works");
  assert.throws(() => parseSignedPreviewOrigin("https://8788-abc.proxy.daytona.works", 3994));
  assert.throws(() => parseSignedPreviewOrigin("https://3994-abc.proxy.daytona.works/?token=x", 3994));
  assert.equal(nodeSupportsGateway("v22.13.0"), true);
  assert.equal(nodeSupportsGateway("v22.12.1"), false);
  assert.equal(nodeSupportsGateway("v24.1.0"), true);
  assert.equal(nodeSupportsGateway("v20.18.0"), false);
  const token = newResetToken();
  assert.match(token, /^[A-Za-z0-9_-]{32,128}$/);
  assert.ok(new Set(token).size >= 16);
});

test("gateway probes pass against the real automatic-join gateway and leave no workspace behind", { timeout: 60_000 }, async (t) => {
  const workshop = await startWorkshop({ joinMode: "automatic", port: 0 });
  t.after(() => workshop.close());
  assert.match(await probeGatewayHealth(workshop.origin), /memory storage/);
  assert.match(await probeAutomaticJoin(workshop.origin), /join/);
  const assigned = await startWorkshop({ joinMode: "assigned", port: 0, participants: [{ id: "p", name: "P", token: newResetToken() }] as never });
  t.after(() => assigned.close());
  await assert.rejects(probeGatewayHealth(assigned.origin), /expected automatic/);
});

test("Daytona gateway path: upload, unpack, detach and probes work through a sandbox-shaped exec", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  const { allocateFreePort } = await import("../../evals/packages/cdp/src/index.ts");
  const { spawn } = await import("node:child_process");
  const port = await allocateFreePort();
  const fakeOrigin = `https://${port}-fake-sandbox.proxy.test`;
  const commands: string[] = [];
  // Runs the exact remote command locally: `daytona exec <sandbox> -- "bash -lc '...'"`.
  const exec = async (args: string[]) => {
    if (args[0] === "preview-url") return { stdout: `time="x" level=info\n${fakeOrigin}\n`, stderr: "", code: 0 };
    assert.equal(args[0], "exec");
    const command = args[3] ?? "";
    commands.push(command);
    return new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
      const child = spawn("bash", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    });
  };
  const fetcher: typeof fetch = (input, init) => fetch(String(input).replace(fakeOrigin, `http://127.0.0.1:${port}`), init);
  const den = { placement: { kind: "daytona", sandboxId: "fake-sandbox" } } as unknown as Parameters<typeof startDaytonaGateway>[1];
  let resetToken = "";
  {
    await using stack = new AsyncDisposableStack();
    const gateway = await startDaytonaGateway(stack, den, { expiresInSeconds: 3600, exec, fetcher, port, log: () => undefined });
    resetToken = gateway.resetToken;
    assert.equal(gateway.origin, fakeOrigin);
    assert.match(await probeGatewayHealth(gateway.origin, fetcher), /sqlite storage/);
    assert.match(await probeAutomaticJoin(gateway.origin, fetcher), /join/);
    const reset = await fetcher(`${gateway.origin}/_workshop/reset-all`, { method: "POST", headers: { authorization: `Bearer ${gateway.resetToken}`, "content-type": "application/json" }, body: JSON.stringify({ confirm: "RESET ALL SAMPLE DATA" }) });
    assert.equal(reset.status, 200);
  }
  // Disposal stopped the detached gateway, and no remote command line carried the reset key in clear text.
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }));
  assert.ok(commands.length > 3);
  for (const command of commands) assert.ok(!command.includes(resetToken));
});

test("model: skipped with a clear note without a key; with a key the policy is org-wide and the key never surfaces", async () => {
  const admin = { apiUrl: "https://api.example", webUrl: "https://web.example", token: "admin-token", email: "h@example.test", password: "x" };
  const skipped = await provisionWorkshopModel({ admin, orgId: "org_1", model: "m", allowanceUsd: "5", gatewayEnabled: true, env: {} });
  assert.equal(skipped.state, "skipped");
  assert.match(skipped.note, /OPENAI_API_KEY/);
  const key = "sk-test-not-a-real-key-000000";
  const calls: { path: string; body: unknown }[] = [];
  const fetcher = async (_ref: unknown, path: string, init: RequestInit = {}) => {
    calls.push({ path, body: JSON.parse(String(init.body ?? "{}")) });
    const body = path === "/v1/inference-providers" ? { inferenceProvider: { id: "ip_1" } } : path === "/v1/gateway/usage-limit-policies" ? { id: "pol_1" } : { assignments: [] };
    return { response: new Response(null, { status: path === "/v1/inference-providers" ? 201 : 200 }), body, text: JSON.stringify(body) };
  };
  const result = await provisionWorkshopModel({ admin, orgId: "org_1", model: "gpt-x", allowanceUsd: "5", gatewayEnabled: true, env: { OPENAI_API_KEY: key }, fetcher });
  assert.equal(result.state, "provisioned");
  assert.deepEqual(calls.map((call) => call.path), ["/v1/inference-providers", "/v1/gateway/usage-limit-policies", "/v1/gateway/usage-limit-policies/pol_1/assignments"]);
  assert.deepEqual(calls[1]?.body, { name: "Workshop allowance $5/day", hardLimit: true, allowRequestReset: true, limits: [{ timeframe: "day", costUsd: "5" }] });
  assert.deepEqual(calls[2]?.body, { organization: true });
  assert.ok(!JSON.stringify(result).includes(key));
  const noGateway = await provisionWorkshopModel({ admin, orgId: "org_1", model: "m", allowanceUsd: "5", gatewayEnabled: false, env: { OPENAI_API_KEY: key }, fetcher });
  assert.equal(noGateway.state, "failed");
});

test("reset command reads the world's outputs and refuses masked or missing values", () => {
  assert.deepEqual(parseResetArgs(["--stage", "acme-oct", "--confirm"]), { stage: "acme-oct", confirm: true });
  assert.deepEqual(parseResetArgs([]), { confirm: false });
  assert.throws(() => parseResetArgs(["--url", "https://x"]));
  const json = JSON.stringify({ exists: true, outputs: { workplace: { value: "https://3994-x.example" }, resetToken: { value: "t".repeat(40) } } });
  assert.deepEqual(readWorldOutputs(json), { origin: "https://3994-x.example", token: "t".repeat(40) });
  assert.throws(() => readWorldOutputs(JSON.stringify({ exists: true, outputs: { workplace: { value: "https://x" }, resetToken: { value: "••••••••" } } })), /reset key/);
  assert.throws(() => readWorldOutputs(JSON.stringify({ exists: false })), /No running workshop/);
});
