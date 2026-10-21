import test from "node:test";
import assert from "node:assert/strict";
import { parseResetOptions, resetWorkshop, RESET_CONFIRMATION } from "./workshop-reset.mjs";

const token = "private-facilitator-key-".repeat(3);
test("reset preview is non-destructive and needs no secret or network", async () => {
  let called = false;
  const options = parseResetOptions(["--url", "https://demo.example", "--all"]);
  const receipt = await resetWorkshop(options, { request: async () => { called = true; throw Error("must not call"); } });
  assert.equal(receipt.performed, false);
  assert.equal(called, false);
  assert.match(receipt.message, /VM files and chat history are not changed/);
});
test("explicit facilitator reset uses a header and exact confirmation, never URL credentials", async () => {
  const options = parseResetOptions(["--url", "https://demo.example", "--all", "--confirm"]);
  const receipt = await resetWorkshop(options, { token, request: async (url, init) => {
    assert.equal(url, "https://demo.example/_workshop/reset-all");
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    assert.equal(init.redirect, "error");
    assert.deepEqual(JSON.parse(init.body), { confirm: RESET_CONFIRMATION });
    return Response.json({ ok: true, reset: "all-sample-data" });
  } });
  assert.equal(receipt.performed, true);
  assert.ok(!JSON.stringify(receipt).includes(token));
});
test("invalid destinations and missing confirmation do not erase anything", async () => {
  for (const url of ["https://user:password@demo.example", "https://demo.example/path", "https://demo.example/?secret=x", "http://demo.example", "file:///tmp/demo"]) {
    assert.throws(() => parseResetOptions(["--url", url, "--all", "--confirm"]));
  }
  assert.throws(() => parseResetOptions(["--url", "https://demo.example", "--confirm"]));
  assert.throws(() => parseResetOptions(["--url", "https://demo.example", "--all", "--confirm", "--confirm"]));
  await assert.rejects(resetWorkshop({ origin: "https://demo.example", confirm: true }, { token: "short" }), /facilitator/);
});
test("failure bodies cannot leak a facilitator key, and uncertain resets are not retried", async () => {
  let calls = 0;
  await assert.rejects(resetWorkshop({ origin: "https://demo.example", confirm: true }, { token, request: async () => {
    calls++;
    return Response.json({ token }, { status: 500 });
  } }), (error) => !error.message.includes(token) && /HTTP 500/.test(error.message));
  assert.equal(calls, 1);
});
test("busy or invalid receipts never become successful reset claims", async () => {
  const options = { origin: "https://demo.example", confirm: true };
  await assert.rejects(resetWorkshop(options, { token, request: async () => new Response(null, { status: 409 }) }), /busy/);
  await assert.rejects(resetWorkshop(options, { token, request: async () => Response.json({ ok: true }) }), /success receipt/);
});
