export type MicrosoftCredentialIdentity = { clientId: string; tenantId: string };
export type MicrosoftCredentialDraft = MicrosoftCredentialIdentity & { clientSecret: string };

const ENTRA_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTRA_DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function microsoftCredentialIdentityChanged(current: MicrosoftCredentialIdentity, saved: MicrosoftCredentialIdentity) {
  return current.clientId.trim() !== saved.clientId.trim()
    || current.tenantId.trim().toLowerCase() !== saved.tenantId.trim().toLowerCase();
}

export function microsoftCredentialRefetchConflicts(latest: MicrosoftCredentialIdentity, saved: MicrosoftCredentialIdentity, submitted: MicrosoftCredentialIdentity | null) {
  return microsoftCredentialIdentityChanged(latest, saved)
    && (!submitted || microsoftCredentialIdentityChanged(latest, submitted));
}

export function microsoftCredentialChanges(draft: MicrosoftCredentialDraft, saved: MicrosoftCredentialIdentity) {
  const clientId = draft.clientId.trim();
  const tenantId = draft.tenantId.trim().toLowerCase();
  const clientSecret = draft.clientSecret.trim();
  const clientChanged = clientId !== saved.clientId.trim();
  const identityChanged = microsoftCredentialIdentityChanged({ clientId, tenantId }, saved);
  const valid = ENTRA_GUID.test(clientId) && (ENTRA_GUID.test(tenantId) || ENTRA_DOMAIN.test(tenantId))
    && clientSecret.length <= 4096 && (!clientChanged || Boolean(clientSecret));
  return {
    clientChanged,
    identityChanged,
    changed: identityChanged || Boolean(clientSecret),
    valid,
    credentials: {
      ...(identityChanged ? { clientId, tenantId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
    },
    identity: { clientId, tenantId },
  };
}
