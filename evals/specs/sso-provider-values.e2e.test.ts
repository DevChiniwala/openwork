import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "vitest";
import { chrome, server, setViewport, test } from "@openwork/testkit";
import { callFunction, evaluate, navigate } from "@openwork/cdp";
import type { CdpClient } from "@openwork/cdp";
import { SAML_SETUP_DESIGN } from "../../ee/apps/den-web/app/(den)/dashboard/_components/sso-provider-values";
import { parseOrgSsoPayload } from "../../ee/apps/den-web/app/(den)/_lib/den-org";

async function eventually(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(2_000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function click(client: CdpClient, selector: string) {
  const point = await callFunction(client, (selector) => {
    const button = document.querySelector(selector);
    if (!(button instanceof HTMLElement)) throw new Error(`Missing control: ${selector}`);
    button.scrollIntoView({ block: "center" });
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, [selector]);
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}

test("saved SAML setup switches labels and protocol without writes, and every Copy button copies its own value", async ({ place }) => {
  // Local placement was explicitly requested for this isolated UI comparison.
  // No published customer system or running desktop app is used.
  await using den = await server({
    place, web: true,
    publicOrigins: { web: "https://ow.ai.example.test", api: "https://api-ow.ai.example.test" },
    org: { name: "Example Workspace", admin: { name: "Example Admin", email: "admin@sso.example.test" }, members: {} },
  });
  const login = await fetch(`${den.ref.apiUrl}/api/auth/sign-in/email`, {
    method: "POST", headers: { "content-type": "application/json", origin: den.ref.webUrl },
    body: JSON.stringify({ email: den.admin.email, password: den.admin.password }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  const headers = { cookie, authorization: `Bearer ${den.admin.token}`, "content-type": "application/json" };
  const cert = execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "/dev/null", "-out", "/dev/stdout", "-days", "1", "-subj", "/CN=idp.example.test"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const saved = await fetch(`${den.ref.apiUrl}/v1/sso/saml`, {
    method: "POST", headers,
    body: JSON.stringify({ issuer: "https://idp.example.test/issuer", domain: "example.test", entryPoint: "https://idp.example.test/sso", cert }),
  });
  expect(saved.status).toBe(201);
  // Registration also requests a domain token after taking its response snapshot.
  // Compare GET with GET so that token bookkeeping is not mistaken for a UI write.
  const initial = await fetch(`${den.ref.apiUrl}/v1/sso`, { headers });
  expect(initial.status).toBe(200);
  const { connection: savedConnection } = parseOrgSsoPayload(await initial.json());
  if (!savedConnection) throw new Error("SSO registration did not return its configuration");
  expect(savedConnection.acsUrl).toContain("https://ow.ai.example.test/api/auth/sso/saml2/sp/acs/");
  expect(savedConnection.redirectUrl).toContain("https://api-ow.ai.example.test/api/auth/sso/callback/");

  await using browser = await chrome({ name: "sso-provider-values", headless: true, startUrl: den.ref.webUrl, host: place.host() });
  const client = browser.client;
  await setViewport(browser, { width: 1440, height: 1000, deviceScaleFactor: 1 });
  await eventually(() => callFunction(client, url => location.href.startsWith(url) && document.readyState === "complete", [den.ref.webUrl]), "Den web origin");
  // This is the standard testkit Den web token handoff, not a replacement UI.
  await callFunction(client, token => { localStorage.setItem("openwork:web:auth-token", token); }, [den.admin.token]);
  await navigate(client, `${den.ref.webUrl}/dashboard/sso`);
  await eventually(() => evaluate(client, () => Boolean(document.querySelector('[data-sso-value="entity"]'))), "saved SAML values");
  await client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await client.send("Browser.grantPermissions", { origin: den.ref.webUrl, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });

  async function readRows() {
    return evaluate(client, () => Array.from(document.querySelectorAll<HTMLElement>("[data-sso-value]")).map(row => ({ key: row.dataset.ssoValue, label: row.querySelector("p")?.textContent, value: row.querySelector("code")?.textContent })));
  }
  async function checkCopies() {
    const rows = await readRows();
    for (const row of rows) {
      await click(client, `[data-sso-value="${row.key}"] button`);
      await eventually(async () => await evaluate(client, () => navigator.clipboard.readText()) === row.value, `clipboard for ${row.key}`);
    }
    return rows;
  }
  const entra = await checkCopies();
  expect(entra.map(row => row.label)).toEqual(["Identifier (Entity ID)", "Reply URL (Assertion Consumer Service URL)", "Sign on URL", "Metadata URL"]);
  expect(entra.map(row => row.value)).toEqual(["https://ow.ai.example.test", savedConnection.acsUrl, savedConnection.signInUrl, savedConnection.metadataUrl]);
  expect(entra.some(row => row.value === savedConnection.redirectUrl)).toBe(false);
  if (SAML_SETUP_DESIGN === "b") {
    for (const idp of ["Okta", "Other SAML", "Microsoft Entra"]) {
      await click(client, '[aria-label="SAML identity provider"]');
      await eventually(() => evaluate(client, () => Boolean(document.querySelector('[role="listbox"]'))), "IdP picker");
      const selector = await callFunction(client, name => {
        const options = Array.from(document.querySelectorAll('[role="option"]'));
        const option = options.find(option => option.textContent?.trim() === name);
        if (!option) throw new Error("Missing IdP option");
        return `[id="${option.id}"]`;
      }, [idp]);
      await click(client, selector);
      await eventually(() => evaluate(client, () => !document.querySelector('[role="listbox"]')), "closed IdP picker");
      const rows = await checkCopies();
      expect(Object.fromEntries(rows.map(row => [row.key, row.value]))).toEqual(Object.fromEntries(entra.map(row => [row.key, row.value])));
      if (idp === "Okta") expect(rows.map(row => row.label)).toEqual(["Single sign-on URL", "Audience URI (SP Entity ID)", "SP-initiated sign-in URL", "Metadata URL"]);
      if (idp === "Other SAML") expect(rows.map(row => row.label)).toEqual(["SP Entity ID", "ACS URL", "SP-initiated sign-in URL", "Metadata URL"]);
    }
  }
  await click(client, '[aria-label="Provider setup protocol"] button[aria-pressed="false"]');
  await eventually(() => evaluate(client, () => Boolean(document.querySelector('[data-sso-value="redirect"]'))), "OIDC callback");
  const oidc = await checkCopies();
  expect(oidc.map(row => [row.label, row.value])).toEqual([["Sign-in URL", savedConnection.signInUrl], ["Redirect URL", savedConnection.redirectUrl]]);
  expect(oidc.some(row => row.value === savedConnection.acsUrl)).toBe(false);
  await click(client, '[aria-label="Provider setup protocol"] button[aria-pressed="false"]');
  await eventually(() => evaluate(client, () => Boolean(document.querySelector('[data-sso-value="entity"]'))), "SAML restored");
  expect(await readRows()).toEqual(entra);
  const after = await fetch(`${den.ref.apiUrl}/v1/sso`, { headers });
  expect(after.status).toBe(200);
  expect(parseOrgSsoPayload(await after.json()).connection).toEqual(savedConnection);
});
