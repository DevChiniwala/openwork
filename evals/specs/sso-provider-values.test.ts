import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getSamlEntityId, getSsoSetupValues, SsoProviderValues } from "../../ee/apps/den-web/app/(den)/dashboard/_components/sso-provider-values";
import { getEmailDomain, getSsoDomainWarning, getSsoRequestError, SsoAdvancedAudience, SsoDomainField, SsoEnableWarning } from "../../ee/apps/den-web/app/(den)/dashboard/_components/sso-form-guidance";
import type { DenOrgSsoConnection } from "../../ee/apps/den-web/app/(den)/_lib/den-org";

const connection: DenOrgSsoConnection = {
  id: "example-sso", providerId: "example-provider", kind: "saml", issuer: "https://idp.example.test", domain: "example.test",
  status: "disabled", testStatus: "untested", testExpiresAt: null, signInPath: "/sso/example-workspace",
  signInUrl: "https://ow.ai.example.test/sso/example-workspace",
  redirectUrl: "https://api-ow.ai.example.test/api/auth/sso/callback/example-provider",
  acsUrl: "https://ow.ai.example.test/api/auth/sso/saml2/sp/acs/example-provider",
  metadataUrl: "https://ow.ai.example.test/api/auth/sso/saml2/sp/metadata?providerId=example-provider",
  domainVerified: true, domainVerificationHost: "_example", domainVerificationDnsName: "_example.example.test",
  oidc: null, saml: { entryPoint: "https://idp.example.test/sso", audience: null, wantAssertionsSigned: true },
  lastTestedAt: null, lastError: null, createdAt: null, updatedAt: null,
};

function render(saved: DenOrgSsoConnection, copiedValue: string | null = null) {
  return renderToStaticMarkup(createElement(SsoProviderValues, { connection: saved, copiedValue, onCopy: () => {} }));
}

test("saved SAML has four generic rows in order, exact synonym hints and correctly paired values", () => {
  const rows = getSsoSetupValues(connection);
  expect(rows.map(row => row.key)).toEqual(["entity", "acs", "signin", "metadata"]);
  expect(rows.map(row => row.label)).toEqual(["Entity ID", "ACS URL (Reply URL)", "Sign-in URL", "Metadata URL"]);
  expect(rows.map(row => row.hint)).toEqual([
    "Also called Identifier or Audience URI.",
    "Where your identity provider sends users back after sign-in. Also called Reply URL, Single sign-on URL or Assertion Consumer Service URL.",
    "Optional. Starts sign-in from OpenWork.",
    "For identity providers that can import service provider metadata.",
  ]);
  expect(rows.map(row => row.value)).toEqual(["https://ow.ai.example.test", connection.acsUrl, connection.signInUrl, connection.metadataUrl]);
  expect(rows.some(row => row.value === connection.redirectUrl)).toBe(false);
});

test("SAML setup exposes neither the callback nor a protocol switch, picker or vendor catalog", () => {
  const html = render(connection);
  expect(html).not.toContain(connection.redirectUrl);
  expect(html).not.toContain("Redirect URL");
  expect(html).not.toMatch(/OIDC|Microsoft|Entra|Okta|combobox|listbox|aria-pressed/);
  expect(html.match(/<button/g)).toHaveLength(4);
  expect(html.match(/aria-label="Copy /g)).toHaveLength(4);
  for (const row of getSsoSetupValues(connection)) expect(html).toContain(`aria-label="Copy ${row.label}"`);
});

test("saved OIDC alone exposes the original callback with neutral synonyms, even if stale SAML fields exist", () => {
  const oidc: DenOrgSsoConnection = { ...connection, kind: "oidc" };
  const rows = getSsoSetupValues(oidc);
  expect(rows.map(row => [row.label, row.value])).toEqual([["Sign-in URL", connection.signInUrl], ["Redirect URL", connection.redirectUrl]]);
  expect(rows[1].hint).toBe("Also called Redirect URI.");
  const html = render(oidc);
  expect(html).toContain(connection.redirectUrl);
  expect(html).not.toContain(connection.acsUrl);
  expect(html).not.toContain(connection.metadataUrl);
  expect(html).not.toMatch(/Entity ID|ACS URL|Metadata URL|combobox|aria-pressed/);
  expect(html.match(/aria-label="Copy /g)).toHaveLength(2);
  expect(getSamlEntityId(oidc)).toBeNull();
});

test("persisted custom audience is the Entity ID, never the API callback origin", () => {
  const custom = { ...connection, saml: { entryPoint: null, audience: "https://audience.example.test/tenant", wantAssertionsSigned: true } };
  expect(getSamlEntityId(custom)).toBe("https://audience.example.test/tenant");
  expect(getSamlEntityId(connection)).toBe("https://ow.ai.example.test");
  expect(getSamlEntityId(connection)).not.toBe(new URL(connection.redirectUrl).origin);
});

test("missing or malformed ACS never invents an Entity ID or falls back to the API host", () => {
  expect(getSamlEntityId({ ...connection, acsUrl: null })).toBeNull();
  expect(getSamlEntityId({ ...connection, acsUrl: "not-a-url" })).toBeNull();
});

test("missing values disable their Copy buttons, while copied feedback stays paired with its row", () => {
  const unavailable = render({ ...connection, acsUrl: null, metadataUrl: null });
  expect(unavailable.match(/disabled=""/g)).toHaveLength(3);
  const copied = render(connection, "acs");
  expect(copied.match(/>Copied</g)).toHaveLength(1);
  const acsButton = copied.match(/<button aria-label="Copy ACS URL \(Reply URL\)"[\s\S]*?<\/button>/)?.[0];
  expect(acsButton).toContain(">Copied<");
});

test("deriving and rendering setup values never changes the saved connection", () => {
  const before = structuredClone(connection);
  getSsoSetupValues(connection);
  render(connection);
  expect(connection).toEqual(before);
});

test("setup cards keep the original gray rounded cards, uppercase labels and Copy button styling", () => {
  const html = render(connection);
  expect(html).toContain("Give these values to your identity provider");
  expect(html.match(/rounded-\[20px\] border border-gray-200 bg-gray-50 p-4/g)).toHaveLength(4);
  expect(html.match(/text-\[13px\] font-semibold uppercase tracking-\[0.12em\] text-gray-500/g)).toHaveLength(4);
  expect(html.match(/h-10 px-5/g)).toHaveLength(4);
  expect(html).not.toContain("divide-y");
});

test("owner email prefill is normalized and unavailable or malformed email produces no default", () => {
  expect(getEmailDomain(" Admin@Example.Test ")).toBe("example.test");
  expect(getEmailDomain(null)).toBeNull();
  expect(getEmailDomain("missing-domain@")).toBeNull();
  expect(getEmailDomain("not-an-email")).toBeNull();
  const html = renderToStaticMarkup(createElement(SsoDomainField, { value: "example.test", onChange: () => {}, disabled: false }));
  expect(html).toContain("Users&#x27; email domain");
  expect(html).toContain('value="example.test"');
  expect(html).toContain("Not your identity provider");
  expect(html).toContain("w-full rounded-[18px] border border-gray-200 px-4 py-3");
});

test("domain warning compares available owner/admin emails and does not block saving", () => {
  expect(getSsoDomainWarning("EXAMPLE.TEST", "https://idp.example.test", ["admin@example.test"])).toBeNull();
  expect(getSsoDomainWarning("other.test", "https://idp.example.test", ["owner@example.test", "admin@other.test"])).toBeNull();
  expect(getSsoDomainWarning("tenant.onmicrosoft.example", "https://idp.example.test", ["admin@example.test"])).toContain("The connection was saved, but no workspace owner or admin email uses tenant.onmicrosoft.example.");
  expect(getSsoDomainWarning("example.test", "https://idp.example.test", [])).toBeNull();
  expect(getSsoDomainWarning("tenant.onmicrosoft.com", "https://idp.example.test", [])).toContain("looks like an identity provider domain");
  expect(getSsoDomainWarning("idp.example.test", "https://idp.example.test/issuer", [])).toContain("looks like an identity provider domain");
  expect(getSsoDomainWarning("example.test", "not-a-url", [])).toBeNull();
});

test("Audience URL is in a native collapsed Advanced section and retains its saved value", () => {
  const html = renderToStaticMarkup(createElement(SsoAdvancedAudience, { value: "https://audience.example.test", onChange: () => {}, disabled: false }));
  expect(html).toMatch(/<details[^>]*><summary/);
  expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  expect(html).toContain("Advanced</summary>");
  expect(html).toContain("Audience URL");
  expect(html).toContain('value="https://audience.example.test"');
  expect(html).toContain("Leave blank to use the Entity ID shown above.");
});

test("enable dialog warns that email/password sign-in stops, using the existing dialog text style", () => {
  const html = renderToStaticMarkup(createElement(SsoEnableWarning));
  expect(html).toContain("Once enabled, email and password sign-in stops for everyone in this workspace, including you. Keep this admin session open until you have signed in with SSO.");
  expect(html).toContain("mt-2 pr-8 text-[14px] leading-6 text-slate-600");
});

test("only a single_org_mode 409 receives the sign-out/sign-in recovery text", () => {
  const payload = { error: "single_org_mode", message: "Additional organization changes are disabled." };
  expect(getSsoRequestError(payload, new Response(null, { status: 409 }), "fallback").message).toBe("Additional organization changes are disabled. Sign out and sign back in, then try again.");
  expect(getSsoRequestError(payload, new Response(null, { status: 400 }), "fallback").message).toBe(payload.message);
  expect(getSsoRequestError({ error: "other", message: "Another conflict." }, new Response(null, { status: 409 }), "fallback").message).toBe("Another conflict.");
});
