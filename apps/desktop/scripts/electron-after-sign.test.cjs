const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { after, before, test } = require("node:test");
const afterSign = require("./electron-after-sign.cjs");

const environment = {
  MACOS_NOTARIZE: "true",
  APPLE_API_KEY_PATH: "/test/not-a-real-key.p8",
  APPLE_API_KEY: "test-key-id",
  APPLE_API_ISSUER: "test-issuer",
};
const originalEnvironment = {};
before(() => {
  for (const [name, value] of Object.entries(environment)) {
    originalEnvironment[name] = process.env[name];
    process.env[name] = value;
  }
});
after(() => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function harness(results) {
  const commands = [];
  const reports = [];
  const notaryCalls = [];
  const dependencies = {
    runCommand(command, args) { commands.push({ command, args }); },
    async runRetry(command, args, attempts) { commands.push({ command, args, attempts }); },
    spawnNotary(command, args, options) {
      notaryCalls.push({ command, args, options });
      assert.ok(results.length, "unexpected notarytool call");
      return results.shift();
    },
    report(message) { reports.push(message); },
  };
  return {
    commands, reports, notaryCalls,
    run() {
      return afterSign({
        electronPlatformName: "darwin",
        appOutDir: "/test/output",
        packager: { appInfo: { productFilename: "Test App" } },
      }, dependencies);
    },
    assertCleanedUp() {
      const zipPath = commands[0].args.at(-1);
      assert.equal(existsSync(path.dirname(zipPath)), false);
    },
  };
}

const success = (value) => ({ status: 0, stdout: JSON.stringify(value) });

test("Accepted submission staples with retries and verifies the signed app", async () => {
  const h = harness([success({ id: "submission-id", status: "Accepted" })]);
  await h.run();
  assert.equal(h.notaryCalls.length, 1);
  const submit = h.notaryCalls[0];
  assert.equal(submit.command, "xcrun");
  assert.deepEqual(submit.args.slice(0, 2), ["notarytool", "submit"]);
  assert.ok(submit.args.includes("--wait"));
  assert.deepEqual(submit.args.slice(4, 6), ["--output-format", "json"]);
  assert.deepEqual(submit.options, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.deepEqual(h.commands.slice(1), [
    { command: "xcrun", args: ["stapler", "staple", "/test/output/Test App.app"], attempts: 5 },
    { command: "codesign", args: ["--verify", "--deep", "--strict", "--verbose=2", "/test/output/Test App.app"] },
    { command: "spctl", args: ["--assess", "--type", "execute", "--verbose=2", "/test/output/Test App.app"] },
    { command: "xcrun", args: ["stapler", "validate", "/test/output/Test App.app"] },
  ]);
  h.assertCleanedUp();
});

test("Invalid with exit zero fetches issue report using the same credentials and never staples", async () => {
  const h = harness([
    success({ id: "rejected-id", status: "Invalid" }),
    success({ issues: [{ message: "The binary is not signed." }], echoedKey: environment.APPLE_API_KEY }),
  ]);
  await assert.rejects(h.run(), /not Accepted/);
  assert.equal(h.commands.length, 1);
  assert.equal(h.notaryCalls.length, 2);
  assert.deepEqual(h.notaryCalls[1].args, [
    "notarytool", "log", "rejected-id",
    "--key", environment.APPLE_API_KEY_PATH,
    "--key-id", environment.APPLE_API_KEY,
    "--issuer", environment.APPLE_API_ISSUER,
  ]);
  assert.match(h.reports.join("\n"), /The binary is not signed/);
  for (const [name, value] of Object.entries(environment)) {
    if (name !== "MACOS_NOTARIZE") assert.ok(!h.reports.join("\n").includes(value));
  }
  h.assertCleanedUp();
});

for (const [name, result, message] of [
  ["malformed JSON", { status: 0, stdout: "not json" }, /malformed JSON/],
  ["missing status", success({ id: "submission-id" }), /without a status/],
  ["null JSON", success(null), /without a status/],
  ["failed process", { status: 1, stderr: environment.APPLE_API_KEY }, /submit failed with status 1/],
  ["spawn error", { status: null, error: Object.assign(new Error("secret command arguments"), { code: "ENOENT" }) }, /process error \(ENOENT\)/],
  ["terminated process", { status: null, signal: "SIGTERM" }, /signal SIGTERM/],
]) {
  test(`${name} fails clearly without stapling or leaking command arguments`, async () => {
    const h = harness([result]);
    await assert.rejects(h.run(), (error) => {
      assert.match(error.message, message);
      assert.ok(!error.message.includes(environment.APPLE_API_KEY));
      assert.ok(!error.message.includes("secret command arguments"));
      return true;
    });
    assert.equal(h.commands.length, 1);
    assert.equal(h.notaryCalls.length, 1);
    h.assertCleanedUp();
  });
}

test("failure fetching a rejection log still fails without stapling", async () => {
  const h = harness([
    success({ id: "rejected-id", status: "Invalid" }),
    { status: 1, stderr: environment.APPLE_API_KEY },
  ]);
  await assert.rejects(h.run(), /not Accepted/);
  assert.match(h.reports.join("\n"), /notarytool log failed with status 1/);
  assert.equal(h.commands.length, 1);
  h.assertCleanedUp();
});
