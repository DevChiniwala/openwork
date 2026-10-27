import assert from "node:assert/strict";
import { test } from "node:test";
import { microsoftCredentialChanges, microsoftCredentialIdentityChanged, microsoftCredentialRefetchConflicts } from "./microsoft-credential-draft";

const saved = { clientId: "11111111-1111-1111-1111-111111111111", tenantId: "22222222-2222-2222-2222-222222222222" };
const draft = { ...saved, clientSecret: "" };

test("unchanged credentials are valid and omitted for a permissions-only save", () => {
  const changes = microsoftCredentialChanges(draft, saved);
  assert.equal(changes.changed, false);
  assert.equal(changes.valid, true);
  assert.deepEqual(changes.credentials, {});
});

test("secret rotation keeps IDs and does not need an identity confirmation", () => {
  const changes = microsoftCredentialChanges({ ...draft, clientSecret: " replacement " }, saved);
  assert.equal(changes.changed, true);
  assert.equal(changes.identityChanged, false);
  assert.equal(changes.valid, true);
  assert.deepEqual(changes.credentials, { clientSecret: "replacement" });
});

test("a different client cannot reuse the saved secret", () => {
  const changedClient = { ...draft, clientId: "33333333-3333-3333-3333-333333333333" };
  assert.equal(microsoftCredentialChanges(changedClient, saved).valid, false);
  const changes = microsoftCredentialChanges({ ...changedClient, clientSecret: "replacement" }, saved);
  assert.equal(changes.valid, true);
  assert.equal(changes.identityChanged, true);
  assert.deepEqual(changes.credentials, { clientId: changedClient.clientId, tenantId: saved.tenantId, clientSecret: "replacement" });
});

test("tenant change accepts a verified domain without resending the secret", () => {
  const changes = microsoftCredentialChanges({ ...draft, tenantId: " Example.onmicrosoft.com " }, saved);
  assert.equal(changes.valid, true);
  assert.equal(changes.identityChanged, true);
  assert.deepEqual(changes.credentials, { clientId: saved.clientId, tenantId: "example.onmicrosoft.com" });
});

test("blank, malformed and shared Microsoft authority IDs cannot save", () => {
  for (const tenantId of ["", "common", "organizations", "consumers", "not a tenant", "https://example.com", "a".repeat(254) + ".com"]) {
    assert.equal(microsoftCredentialChanges({ ...draft, tenantId }, saved).valid, false);
  }
  for (const clientId of ["", "not-an-app-id"]) {
    assert.equal(microsoftCredentialChanges({ ...draft, clientId, clientSecret: "replacement" }, saved).valid, false);
  }
});

test("a refetched app identity is checked against the saved baseline, not the secret-only draft", () => {
  const secretOnly = microsoftCredentialChanges({ ...draft, clientSecret: "replacement" }, saved);
  assert.equal(secretOnly.identityChanged, false);
  assert.equal(microsoftCredentialIdentityChanged({ ...saved, clientId: "33333333-3333-3333-3333-333333333333" }, saved), true);
  assert.equal(microsoftCredentialIdentityChanged({ ...saved, tenantId: "44444444-4444-4444-4444-444444444444" }, saved), true);
  assert.equal(microsoftCredentialIdentityChanged({ clientId: ` ${saved.clientId} `, tenantId: " EXAMPLE.COM " }, { ...saved, tenantId: "example.com" }), false);
});

test("a refresh of our submitted identity may arrive before the save promise resolves", () => {
  const submitted = { ...saved, clientId: "33333333-3333-3333-3333-333333333333" };
  assert.equal(microsoftCredentialRefetchConflicts(submitted, saved, submitted), false);
  assert.equal(microsoftCredentialRefetchConflicts(submitted, submitted, null), false);
  // A failed or abandoned save cannot consume that refresh as the old baseline.
  assert.equal(microsoftCredentialRefetchConflicts(submitted, saved, null), true);
  const anotherApp = { ...saved, clientId: "44444444-4444-4444-4444-444444444444" };
  assert.equal(microsoftCredentialRefetchConflicts(anotherApp, saved, submitted), true);
});

test("whitespace and tenant casing alone do not write credentials", () => {
  const changes = microsoftCredentialChanges({ clientId: ` ${saved.clientId} `, tenantId: " EXAMPLE.COM ", clientSecret: "  " }, { ...saved, tenantId: "example.com" });
  assert.equal(changes.changed, false);
  assert.deepEqual(changes.credentials, {});
});
