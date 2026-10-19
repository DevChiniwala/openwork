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

for (const design of ["a", "b"] satisfies ("a" | "b")[]) {
  test(`design ${design}: SAML omits the OIDC callback and renders four correctly paired Copy buttons`, () => {
    const rows = getSsoSetupValues(connection, "saml", design, "entra");
    expect(rows.map(row => row.key)).toEqual(["entity", "acs", "signin", "metadata"]);
    expect(rows.map(row => row.value)).toEqual(["https://ow.ai.example.test", connection.acsUrl, connection.signInUrl, connection.metadataUrl]);
    expect(rows.some(row => row.value === connection.redirectUrl)).toBe(false);
    const html = renderToStaticMarkup(createElement(SsoProviderValues, { connection, mode: "saml", design, copiedValue: null, onModeChange: () => {}, onCopy: () => {} }));
    expect(html).not.toContain(connection.redirectUrl);
    expect(html.match(/aria-label="Copy /g)).toHaveLength(4);
    for (const row of rows) expect(html).toContain(`aria-label="Copy ${row.label}"`);
    expect(html).toContain("Use these values for SAML. The OIDC redirect URL is on the OIDC tab.");
  });
  test(`design ${design}: OIDC preserves Sign-in and Redirect URL, without SAML setup rows`, () => {
    const rows = getSsoSetupValues(connection, "oidc", design, "entra");
    expect(rows.map(row => [row.label, row.value])).toEqual([["Sign-in URL", connection.signInUrl], ["Redirect URL", connection.redirectUrl]]);
    const html = renderToStaticMarkup(createElement(SsoProviderValues, { connection, mode: "oidc", design, copiedValue: null, onModeChange: () => {}, onCopy: () => {} }));
    expect(html).toContain(connection.redirectUrl);
    expect(html).not.toContain(connection.acsUrl);
    expect(html).not.toContain("SAML identity provider");
    expect(html.match(/aria-label="Copy /g)).toHaveLength(2);
  });
}

test("neutral design has the requested labels and Entra hints without a picker", () => {
  const rows = getSsoSetupValues(connection, "saml", "a", "other");
  expect(rows.map(row => row.label)).toEqual(["Identifier (Entity ID)", "Reply URL (Assertion Consumer Service URL)", "Sign on URL", "Metadata URL"]);
  expect(rows[1].hint).toBe("Microsoft Entra: Basic SAML Configuration > Reply URL");
  const html = renderToStaticMarkup(createElement(SsoProviderValues, { connection, mode: "saml", design: "a", copiedValue: null, onModeChange: () => {}, onCopy: () => {} }));
  expect(html).not.toContain("SAML identity provider");
});

test("picker labels match each IdP, while keys retain exactly the same values", () => {
  const entra = getSsoSetupValues(connection, "saml", "b", "entra");
  const okta = getSsoSetupValues(connection, "saml", "b", "okta");
  const other = getSsoSetupValues(connection, "saml", "b", "other");
  expect(okta.map(row => row.label)).toEqual(["Single sign-on URL", "Audience URI (SP Entity ID)", "SP-initiated sign-in URL", "Metadata URL"]);
  expect(other.map(row => row.label)).toEqual(["SP Entity ID", "ACS URL", "SP-initiated sign-in URL", "Metadata URL"]);
  expect(okta.find(row => row.key === "signin")?.hint).toContain("No equivalent Okta setup field verified.");
  const valuesByKey = (rows: ReturnType<typeof getSsoSetupValues>) => Object.fromEntries(rows.map(row => [row.key, row.value]));
  expect(valuesByKey(okta)).toEqual(valuesByKey(entra));
  expect(valuesByKey(other)).toEqual(valuesByKey(entra));
});

test("persisted custom audience is the Entity ID; unsaved field edits cannot change it", () => {
  const custom = { ...connection, saml: { entryPoint: null, audience: "https://audience.example.test/tenant", wantAssertionsSigned: true } };
  expect(getSamlEntityId(custom)).toBe("https://audience.example.test/tenant");
  expect(getSamlEntityId(connection)).toBe("https://ow.ai.example.test");
  expect(getSamlEntityId(connection)).not.toBe(new URL(connection.redirectUrl).origin);
});

test("missing or malformed ACS never invents an Entity ID or falls back to the API host", () => {
  expect(getSamlEntityId({ ...connection, acsUrl: null })).toBeNull();
  expect(getSamlEntityId({ ...connection, acsUrl: "not-a-url" })).toBeNull();
});
