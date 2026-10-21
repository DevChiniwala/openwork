import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from "@openwork/types/den/password-policy";
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

async function setField(client: CdpClient, label: string, value: string) {
  await callFunction(client, (label, value) => {
    const field = Array.from(document.querySelectorAll('label')).find(element => element.querySelector('span')?.textContent === label)?.querySelector('input,textarea');
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) throw new Error(`Missing field: ${label}`);
    field.focus();
    const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }, [label, value]);
}

async function setupPrecedesVerification(client: CdpClient) {
  return evaluate(client, () => {
    const setup = document.querySelector('[data-testid="sso-provider-setup"]');
    const verification = document.querySelector('[data-testid="sso-domain-verification"], [data-testid="sso-domain-verified"]');
    if (!setup || !verification) throw new Error('Missing setup or verification block');
    return Boolean(setup.compareDocumentPosition(verification) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
}

test("generic setup follows the saved protocol despite unsaved form tabs, and every Copy button copies its own value", async ({ place }) => {
  // Local placement was explicitly requested for this isolated UI comparison.
  // No published customer system or running desktop app is used.
  await using den = await server({
    place, web: true,
    publicOrigins: { web: "https://ow.ai.example.test", api: "https://api-ow.ai.example.test" },
    org: { name: "Example Workspace", admin: { name: "Example Admin", email: "admin@example.test" }, members: {} },
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
    body: JSON.stringify({ issuer: "https://sts.windows.net/00000000-0000-0000-0000-000000000001/", domain: "example.test", entryPoint: "https://idp.example.test/sso", cert }),
  });
  expect(saved.status).toBe(201);
  // Registration also requests a domain token after taking its response snapshot.
  // Compare GET with GET so that token bookkeeping is not mistaken for a UI write.
  const initial = await fetch(`${den.ref.apiUrl}/v1/sso`, { headers });
  expect(initial.status).toBe(200);
  const { connection: savedConnection } = parseOrgSsoPayload(await initial.json());
  if (!savedConnection) throw new Error("SSO registration did not return its configuration");
  expect(savedConnection.acsUrl).toContain("https://ow.ai.example.test/api/auth/sso/saml2/sp/acs/");
  // The form renders the API-provided value; the separate redirect-contract
  // spec owns its host/runtime equality, so this UI-only branch composes with that fix.
  expect(new URL(savedConnection.redirectUrl).pathname).toBe(`/api/auth/sso/callback/${encodeURIComponent(savedConnection.providerId)}`);

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
  expect(await setupPrecedesVerification(client)).toBe(true);
  expect(saml.map(row => row.label)).toEqual(["Entity ID", "ACS URL (Reply URL)", "Sign-in URL", "Metadata URL"]);
  expect(saml.map(row => row.value)).toEqual(["https://ow.ai.example.test", savedConnection.acsUrl, savedConnection.signInUrl, savedConnection.metadataUrl]);
  expect(saml.some(row => row.value === savedConnection.redirectUrl)).toBe(false);
  expect(await evaluate(client, () => document.querySelector('[data-testid="sso-provider-setup"]')?.querySelectorAll('button').length)).toBe(4);
  expect(await evaluate(client, () => document.querySelector('[data-testid="sso-provider-setup"]')?.textContent)).not.toMatch(/OIDC|Microsoft|Entra|Okta/);

  await click(client, "button", "Enable Config");
  await eventually(() => evaluate(client, () => Boolean(document.querySelector('[data-testid="sso-test-dialog"]'))), "enable dialog");
  expect(await evaluate(client, () => document.querySelector('[data-testid="sso-test-dialog"]')?.textContent)).toContain("Once enabled, email and password sign-in stops for everyone in this workspace, including you. Keep this admin session open until you have signed in with SSO.");
  await click(client, "button", "Close");
  await click(client, "button", "Edit connection");
  await eventually(() => evaluate(client, () => document.body.innerText.includes("IdP Certificate")), "SAML form");
  const form = await evaluate(client, () => ({
    labels: Array.from(document.querySelectorAll('label')).map(label => label.querySelector('span')?.textContent),
    advancedOpen: document.querySelector('details')?.open,
    domain: Array.from(document.querySelectorAll('label')).find(label => label.querySelector('span')?.textContent === "Users' email domain")?.querySelector('input')?.value,
  }));
  expect(form.labels[0]).toBe("Users' email domain");
  expect(form.labels[1]).toBe("IdP Issuer URL");
  expect(form.domain).toBe("example.test");
  expect(form.advancedOpen).toBe(false);
  expect(await evaluate(client, () => document.body.innerText)).toContain('We recommend signing SAML assertions with SHA-256.');
  await click(client, 'summary', 'Advanced');
  expect(await evaluate(client, () => document.querySelector('details')?.textContent)).toContain('Leave blank to use OpenWork’s Entity ID (shown in the values to give your identity provider).');
  await setField(client, "Users' email domain", 'example.test,wrong.test');
  await click(client, 'p', 'Paste the values from your identity provider');
  await eventually(() => evaluate(client, () => Boolean(document.querySelector('[data-notice-tone="warning"]'))), 'warning on domain blur');
  const warning = await evaluate(client, () => document.querySelector('[data-notice-tone="warning"]')?.textContent);
  expect(warning).toContain('matches wrong.test.');
  expect(warning).not.toContain('example.test');
  await setField(client, "Users' email domain", ' EXAMPLE.TEST , example.test ');
  await click(client, 'p', 'Paste the values from your identity provider');
  await eventually(() => evaluate(client, () => !document.querySelector('[data-notice-tone="warning"]')), 'no false CSV warning on blur');
  await setField(client, "Users' email domain", 'example.test');
  await click(client, 'p', 'Paste the values from your identity provider');
  await click(client, "button", "OIDC");
  await eventually(() => evaluate(client, () => document.body.innerText.includes("Client ID")), "unsaved OIDC form tab");
  expect(await evaluate(client, () => document.body.innerText)).toContain("The issuer from your identity provider's OpenID configuration (not the authorize or token URL), e.g. https://login.microsoftonline.com/<tenant-id>/v2.0.");
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
  expect(await setupPrecedesVerification(client)).toBe(true);
  expect(oidc.map(row => [row.label, row.value])).toEqual([["Sign-in URL", savedOidc.signInUrl], ["Redirect URL", savedOidc.redirectUrl]]);
  expect(oidc.some(row => row.value === savedConnection.acsUrl)).toBe(false);
  expect(await evaluate(client, () => document.querySelector('[data-testid="sso-provider-setup"]')?.textContent)).toContain("Also called Redirect URI.");
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

test("multi-domain blur warning names only unmatched entries and remains after a non-blocking UI save", async ({ place }) => {
  await using den = await server({ place, web: true, org: { name: "Example Workspace", admin: { name: "Example Admin", email: "admin@example.test" }, members: {} } });
  const login = await fetch(`${den.ref.apiUrl}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: den.ref.webUrl }, body: JSON.stringify({ email: den.admin.email, password: den.admin.password }) });
  expect(login.status).toBe(200);
  const cookies = login.headers.getSetCookie();
  await using browser = await chrome({ name: "sso-domain-warning-save", headless: true, startUrl: den.ref.webUrl, host: place.host() });
  const client = browser.client;
  await setViewport(browser, { width: 1440, height: 1200, deviceScaleFactor: 1 });
  await eventually(() => callFunction(client, url => location.href.startsWith(url) && document.readyState === "complete", [den.ref.webUrl]), "domain warning fixture origin");
  await callFunction(client, token => { localStorage.setItem("openwork:web:auth-token", token); }, [den.admin.token]);
  await client.send("Network.setCookies", { cookies: cookies.map(raw => {
    const pair = raw.split(";")[0];
    const at = pair.indexOf("=");
    return { name: pair.slice(0, at), value: pair.slice(at + 1), url: den.ref.webUrl, httpOnly: true, secure: raw.toLowerCase().includes("; secure") };
  }) });
  await navigate(client, `${den.ref.webUrl}/dashboard/sso`);
  await eventually(() => evaluate(client, () => document.body.innerText.includes("IdP Certificate")), "empty SAML form");
  const cert = execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "/dev/null", "-out", "/dev/stdout", "-days", "1", "-subj", "/CN=idp.example.test"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  await setField(client, "IdP Issuer URL", "https://idp.example.test/issuer");
  await setField(client, "SAML Entry Point", "https://idp.example.test/sso");
  await setField(client, "IdP Certificate", cert);
  await setField(client, "Users' email domain", "example.test,wrong.test");
  await click(client, "p", "Paste the values from your identity provider");
  await eventually(() => evaluate(client, () => Boolean(document.querySelector('[data-notice-tone="warning"]'))), "pre-save blur warning");
  const before = await evaluate(client, () => document.querySelector('[data-notice-tone="warning"]')?.textContent);
  expect(before).toContain("matches wrong.test.");
  expect(before).not.toContain("example.test");
  const headers = { authorization: `Bearer ${den.admin.token}` };
  const initial = await fetch(`${den.ref.apiUrl}/v1/sso`, { headers });
  expect(parseOrgSsoPayload(await initial.json()).connection).toBeNull();
  await click(client, "button", "Save SSO connection");
  await eventually(() => evaluate(client, () => Array.from(document.querySelectorAll('button')).some(button => button.textContent?.trim() === "Edit connection") || Boolean(document.querySelector('[role="alert"]'))), "UI save settled");
  expect(await evaluate(client, () => document.querySelector('[role="alert"]')?.textContent ?? null)).toBeNull();
  expect(await evaluate(client, () => document.querySelector('[data-notice-tone="warning"]')?.textContent)).toBe(before);
  const saved = await fetch(`${den.ref.apiUrl}/v1/sso`, { headers });
  expect(saved.status).toBe(200);
  expect(parseOrgSsoPayload(await saved.json()).connection?.domain).toBe("example.test,wrong.test");
  expect(await setupPrecedesVerification(client)).toBe(true);
});

test("initial administrator setup preserves a 40-character paste, shows an inline error and blocks submission without truncation", async ({ place }) => {
  const code = randomUUID();
  await using den = await server({ place, provision: false, web: true, env: {
    DEN_ORG_MODE: 'single_org', DEN_SINGLE_ORG_OWNER_EMAILS: 'admin@example.test',
    DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: 'false', DEN_INITIAL_ADMIN_BOOTSTRAP_CODE: code,
  } });
  await using browser = await chrome({ name: 'setup-password-policy', headless: true, startUrl: den.ref.webUrl, host: place.host() });
  const client = browser.client;
  await setViewport(browser, { width: 1440, height: 1000, deviceScaleFactor: 1 });
  await navigate(client, `${den.ref.webUrl}/setup`);
  await eventually(() => evaluate(client, () => Boolean(document.querySelector('#setup-email'))), 'bootstrap verification form');
  await callFunction(client, (code) => {
    for (const [id, value] of [['setup-email', 'admin@example.test'], ['setup-code', code]]) {
      const input = document.getElementById(id);
      if (!(input instanceof HTMLInputElement)) throw new Error('Missing setup verification input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, [code]);
  await click(client, 'button', 'Continue');
  await eventually(() => evaluate(client, () => Boolean(document.querySelector('#setup-password'))), 'administrator password form');
  const policy = await evaluate(client, () => {
    const input = document.querySelector('#setup-password');
    if (!(input instanceof HTMLInputElement)) throw new Error('Missing setup password field');
    return { min: input.minLength, max: input.maxLength, hint: document.querySelector('#setup-password-policy')?.textContent, describedBy: input.getAttribute('aria-describedby') };
  });
  expect(policy.min).toBe(MIN_PASSWORD_LENGTH);
  expect(policy.max).toBe(-1);
  expect(policy.hint).toContain(`Use ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters.`);
  expect(policy.describedBy).toBe('setup-password-policy');
  await click(client, '#setup-name');
  await client.send('Input.insertText', { text: 'Example Admin' });
  await click(client, '#setup-password');
  // Insert the entire pasted value in one browser input operation, not character-by-character.
  await client.send('Input.insertText', { text: 'x'.repeat(40) });
  await eventually(() => evaluate(client, () => Boolean(document.querySelector('#setup-password-error'))), 'inline overlong-password error');
  const invalid = await evaluate(client, () => {
    const input = document.querySelector('#setup-password');
    if (!(input instanceof HTMLInputElement)) throw new Error('Missing password input');
    return { length: input.value.length, error: document.querySelector('#setup-password-error')?.textContent, invalid: input.getAttribute('aria-invalid'), describedBy: input.getAttribute('aria-describedby'), customError: input.validity.customError, valid: input.checkValidity() };
  });
  expect(invalid.length).toBe(40);
  expect(invalid.error).toBe(`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
  expect(invalid.invalid).toBe('true');
  expect(invalid.describedBy).toContain('setup-password-error');
  expect(invalid.customError).toBe(true);
  expect(invalid.valid).toBe(false);
  const authPostCount = (log: string) => log.split('\n').filter(line => {
    try {
      const entry: unknown = JSON.parse(line);
      return typeof entry === 'object' && entry !== null && 'http_method' in entry && entry.http_method === 'POST' && 'http_route' in entry && typeof entry.http_route === 'string' && entry.http_route.startsWith('/api/auth/');
    } catch { return false; }
  }).length;
  const beforePosts = authPostCount(await den.apiLog());
  await click(client, 'button', 'Create administrator');
  // Also exercise the React submit guard independently of native constraint validation.
  const blocked = await evaluate(client, async () => {
    const input = document.querySelector('#setup-password');
    if (!(input instanceof HTMLInputElement) || !input.form) throw new Error('Missing password form');
    input.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return { length: input.value.length, valid: input.checkValidity(), submitting: document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled };
  });
  expect(blocked).toEqual({ length: 40, valid: false, submitting: false });
  expect(authPostCount(await den.apiLog())).toBe(beforePosts);
  await callFunction(client, value => {
    const input = document.querySelector('#setup-password');
    if (!(input instanceof HTMLInputElement)) throw new Error('Missing password field');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, ['x'.repeat(MAX_PASSWORD_LENGTH)]);
  await eventually(() => evaluate(client, () => !document.querySelector('#setup-password-error')), 'error clears when corrected without truncation');
  expect(await evaluate(client, () => document.querySelector<HTMLInputElement>('#setup-password')?.checkValidity())).toBe(true);
  const status = await fetch(`${den.ref.apiUrl}/v1/auth/bootstrap/status`);
  expect(status.status).toBe(200);
  const payload: unknown = await status.json();
  expect(payload).toMatchObject({ status: 'available' });
});
