import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workshopOauth } from "../worlds/workshop-oauth.ts";
import { record, rows } from "../worlds/workshop-agent.ts";

const test = spec.world(workshopOauth, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 600_000,
});

function payload(result: Record<string, unknown>): Record<string, unknown> {
  const text = rows(result.content).find((part) => part.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Missing MCP result text");
  const value: unknown = JSON.parse(text);
  if (!record(value)) throw new Error("Invalid MCP result body");
  return value;
}

test("two workshop members authorize their own five accounts and keep OAuth Drive writes private without a model", async ({ world, user, probe, step, evidence }) => {
  await step("before: neither member has authorized any of the five workshop connectors", async () => {
    await user.on(world.webA).reload();
    for (const connection of world.connections) {
      expect((await world.connection("a", connection.id))?.connectedForMe).toBe(false);
      expect((await world.connection("b", connection.id))?.connectedForMe).toBe(false);
      expect(connection.url).toBe(`${world.origin}/${connection.app}/mcp`);
    }
    expect(world.connections).toHaveLength(5);
    evidence.recordAssertionEvidence("Both members start with five disconnected per-member OAuth connectors", "Real local private gateway and Den; two isolated headless web profiles; no app runtime, model provider, inference request or hosted-deployment claim.", world.connections.length === 5);
    await user.on(world.webA).screenshot();
  });

  for (const person of ["a", "b"] as const) {
    await step(`member ${person.toUpperCase()} consents to five exact app resources with their own account`, async () => {
      const surface = person === "a" ? world.webA : world.webB;
      const browser = user.on(surface);
      let logins = 0;
      for (const connection of world.connections) {
        await browser.navigate(await world.oauthStart(person, connection.id));
        const text = await probe.eventually(() => probe.on(surface).text(), {
          within: 60_000, label: "the real provider offers login or OAuth consent",
          until: (value) => value.includes("Workshop password") || value.includes("Allow workplace access"),
        });
        if (text.includes("Workshop password")) {
          await browser.type({ label: "Workshop password" }, world.accessCode(person), { sensitive: true });
          await browser.click({ role: "button", label: "Sign in" });
          logins += 1;
        }
        await browser.see({ role: "button", label: "Allow workplace access" }, { timeoutMs: 30_000 });
        await browser.see({ text: person === "a" ? "Avery Workshop" : "Riley Workshop" });
        await browser.click({ text: "Connection details" });
        await browser.see({ text: connection.url });
        await browser.click({ role: "button", label: "Allow workplace access" });
        await probe.eventually(() => world.connection(person, connection.id), {
          within: 60_000, label: `member ${person} has a ready ${connection.app} grant`, until: (value) => value?.connectedForMe === true,
        });
        // Witness the negative half after *every* grant, not just at the end.
        if (person === "a") expect((await world.connection("b", connection.id))?.connectedForMe).toBe(false);
      }
      expect(logins).toBeGreaterThan(0);
      await browser.navigate(`${world.den.ref.webUrl}/dashboard/your-connections`);
      const connected = await Promise.all(world.connections.map((connection) => world.connection(person, connection.id)));
      expect(connected.every((connection) => connection?.connectedForMe === true)).toBe(true);
      evidence.recordAssertionEvidence(`Member ${person.toUpperCase()} owns five ready browser-authorized OAuth grants`, `Den performs discovery, client registration, PKCE and token exchange for outlook, calendar, drive, jira and confluence; ${person === "a" ? "B stayed disconnected after all five A grants" : "B signed in with a distinct generated password in a separate browser profile"}. No direct password API substitutes for OAuth execution.`, connected.every((connection) => connection?.connectedForMe === true));
      await browser.screenshot();
    });
  }

  let fileId = "";
  const filename = `${world.marker}-private.txt`;
  const content = `Private OAuth-owned document ${world.marker}`;
  await step("after: member A writes and reads their private file through Den's OAuth-backed MCP route", async () => {
    const written = await world.drive("a", "file_write", { path: filename, content });
    expect(written.isError).not.toBe(true);
    const file = payload(written);
    expect(file.name).toBe(filename);
    expect(typeof file.id).toBe("string");
    fileId = String(file.id);
    const read = await world.drive("a", "file_read", { item_id: fileId });
    expect(read.isError).not.toBe(true);
    expect(payload(read).content_base64).toBe(Buffer.from(content).toString("base64"));
    await user.on(world.webA).navigate(`${world.origin}/drive`);
    await user.on(world.webA).see({ text: filename }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("A's browser-authorized OAuth grant writes and reads actual private Drive bytes", `search_capabilities → exact discovered execute_capability through /mcp/agent as member A; saved ${filename}; file_read bytes match; same file visible in A's real Drive UI. No LLM or direct service-password write.`, written.isError !== true && payload(read).content_base64 === Buffer.from(content).toString("base64"));
    await user.on(world.webA).screenshot();
  });

  await step("the same Drive URL and file ID never reveal member A's private work to member B", async () => {
    const found = await world.drive("b", "file_find", { query: filename });
    expect(found.isError).not.toBe(true);
    expect(rows(payload(found).value)).toHaveLength(0);
    const denied = await world.drive("b", "file_read", { item_id: fileId });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).not.toContain(Buffer.from(content).toString("base64"));
    await user.on(world.webB).navigate(`${world.origin}/drive`);
    await user.on(world.webB).see({ text: "Northwind-pilot-brief.docx" }, { timeoutMs: 30_000 });
    await user.on(world.webB).notSee({ text: filename });
    const own = await world.drive("a", "file_find", { query: filename });
    expect(rows(payload(own).value)).toHaveLength(1);
    evidence.recordAssertionEvidence("B's separate OAuth grant cannot list or read A's file while A retains it", "Identical connector resource and Drive browser URL: B file_find returns zero, B file_read of A's actual ID returns isError, B's real Drive shows its own seeded brief and no A file; A file_find still returns one. Local fictional-service OAuth isolation, not paid-agent or production-provider coverage.", denied.isError === true && rows(payload(found).value).length === 0 && rows(payload(own).value).length === 1);
    await user.on(world.webB).screenshot();
  });
});
