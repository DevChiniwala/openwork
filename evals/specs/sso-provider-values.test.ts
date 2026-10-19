import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getSamlEntityId, getSsoSetupValues, SsoProviderValues } from "../../ee/apps/den-web/app/(den)/dashboard/_components/sso-provider-values";
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
  expect(rows.map(row => row.label)).toEqual(["Entity ID", "ACS URL", "Sign-in URL", "Metadata URL"]);
  expect(rows.map(row => row.hint)).toEqual([
    "Also called Identifier or Audience URI.",
    "Also called Reply URL or Single sign-on URL. Use this exact value.",
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
  expect(rows[1].hint).toBe("Also called Redirect URI or Callback URL.");
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
  const acsButton = copied.match(/<button aria-label="Copy ACS URL"[\s\S]*?<\/button>/)?.[0];
  expect(acsButton).toContain(">Copied<");
});

test("deriving and rendering setup values never changes the saved connection", () => {
  const before = structuredClone(connection);
  getSsoSetupValues(connection);
  render(connection);
  expect(connection).toEqual(before);
});
