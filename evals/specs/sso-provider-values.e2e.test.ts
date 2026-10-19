import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "vitest";
import { chrome, server, setViewport, test } from "@openwork/testkit";
import { callFunction, evaluate, navigate } from "@openwork/cdp";
import type { CdpClient } from "@openwork/cdp";
import { parseOrgSsoPayload } from "../../ee/apps/den-web/app/(den)/_lib/den-org";

async function eventually(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(2_000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function click(client: CdpClient, selector: string, text = "") {
  const point = await callFunction(client, (selector, text) => {
    const button = Array.from(document.querySelectorAll(selector)).find(button => !text || button.textContent?.trim() === text);
    if (!(button instanceof HTMLElement)) throw new Error(`Missing control: ${selector}`);
    button.scrollIntoView({ block: "center" });
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, [selector, text]);
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}

test("generic setup follows the saved protocol despite unsaved form tabs, and every Copy button copies its own value", async ({ place }) => {
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
  const saml = await checkCopies();
  expect(saml.map(row => row.label)).toEqual(["Entity ID", "ACS URL", "Sign-in URL", "Metadata URL"]);
  expect(saml.map(row => row.value)).toEqual(["https://ow.ai.example.test", savedConnection.acsUrl, savedConnection.signInUrl, savedConnection.metadataUrl]);
  expect(saml.some(row => row.value === savedConnection.redirectUrl)).toBe(false);
  expect(await evaluate(client, () => document.querySelector('[data-testid="sso-provider-setup"]')?.querySelectorAll('button').length)).toBe(4);
  expect(await evaluate(client, () => document.querySelector('[data-testid="sso-provider-setup"]')?.textContent)).not.toMatch(/OIDC|Microsoft|Entra|Okta/);

  await click(client, "button", "Edit connection");
  await eventually(() => evaluate(client, () => document.body.innerText.includes("IdP Certificate")), "SAML form");
  await click(client, "button", "OIDC");
  await eventually(() => evaluate(client, () => document.body.innerText.includes("Client ID")), "unsaved OIDC form tab");
  expect(await checkCopies()).toEqual(saml);
  expect(await evaluate(client, () => Boolean(document.querySelector('[data-sso-value="redirect"]')))).toBe(false);
  const afterSaml = await fetch(`${den.ref.apiUrl}/v1/sso`, { headers });
  expect(afterSaml.status).toBe(200);
  expect(parseOrgSsoPayload(await afterSaml.json()).connection).toEqual(savedConnection);

  // A different saved protocol, not an unsaved tab, is required to expose the callback.
  const registeredOidc = await fetch(`${den.ref.apiUrl}/v1/sso/oidc`, {
    method: "POST", headers,
    body: JSON.stringify({ issuer: "https://idp.example.test/issuer", domain: "example.test", clientId: "example-client", clientSecret: "not-a-real-client-secret", skipDiscovery: true, authorizationEndpoint: "https://idp.example.test/authorize", tokenEndpoint: "https://idp.example.test/token", jwksEndpoint: "https://idp.example.test/jwks" }),
  });
  expect(registeredOidc.status).toBe(201);
  const initialOidc = await fetch(`${den.ref.apiUrl}/v1/sso`, { headers });
  expect(initialOidc.status).toBe(200);
  const { connection: savedOidc } = parseOrgSsoPayload(await initialOidc.json());
  if (!savedOidc) throw new Error("OIDC registration did not return its configuration");
  expect(savedOidc.kind).toBe("oidc");
  await navigate(client, `${den.ref.webUrl}/dashboard/sso`);
  await eventually(() => evaluate(client, () => Boolean(document.querySelector('[data-sso-value="redirect"]'))), "saved OIDC callback");
  const oidc = await checkCopies();
  expect(oidc.map(row => [row.label, row.value])).toEqual([["Sign-in URL", savedOidc.signInUrl], ["Redirect URL", savedOidc.redirectUrl]]);
  expect(oidc.some(row => row.value === savedConnection.acsUrl)).toBe(false);
  expect(await evaluate(client, () => document.querySelector('[data-testid="sso-provider-setup"]')?.textContent)).toContain("Also called Redirect URI or Callback URL.");
  await click(client, "button", "Edit connection");
  await eventually(() => evaluate(client, () => document.body.innerText.includes("Client ID")), "OIDC form");
  await click(client, "button", "SAML");
  await eventually(() => evaluate(client, () => document.body.innerText.includes("IdP Certificate")), "unsaved SAML form tab");
  expect(await checkCopies()).toEqual(oidc);
  expect(await evaluate(client, () => Boolean(document.querySelector('[data-sso-value="acs"]')))).toBe(false);
  const afterOidc = await fetch(`${den.ref.apiUrl}/v1/sso`, { headers });
  expect(afterOidc.status).toBe(200);
  expect(parseOrgSsoPayload(await afterOidc.json()).connection).toEqual(savedOidc);
});
