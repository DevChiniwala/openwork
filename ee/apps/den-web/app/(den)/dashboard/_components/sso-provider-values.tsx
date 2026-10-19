"use client";

import { Copy } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import type { DenOrgSsoConnection } from "../../_lib/den-org";

type SetupValue = { key: string; label: string; value: string | null; hint: string };

export function getSamlEntityId(connection: DenOrgSsoConnection): string | null {
  if (connection.kind !== "saml") return null;
  if (connection.saml?.audience) return connection.saml.audience;
  // The API generates the ACS URL on the auth/web origin, which is also
  // the default SP audience. Never use the API-host OIDC callback origin.
  if (!connection.acsUrl) return null;
  try {
    return new URL(connection.acsUrl).origin;
  } catch {
    return null;
  }
}

export function getSsoSetupValues(connection: DenOrgSsoConnection): SetupValue[] {
  // The saved protocol alone controls which setup values are safe to copy.
  // Switching an unsaved form tab must not expose the OIDC callback for SAML.
  if (connection.kind === "oidc") {
    return [
      { key: "signin", label: "Sign-in URL", value: connection.signInUrl, hint: "Optional. Starts sign-in from OpenWork." },
      { key: "redirect", label: "Redirect URL", value: connection.redirectUrl, hint: "Also called Redirect URI or Callback URL." },
    ];
  }
  return [
    { key: "entity", label: "Entity ID", value: getSamlEntityId(connection), hint: "Also called Identifier or Audience URI." },
    { key: "acs", label: "ACS URL", value: connection.acsUrl, hint: "Also called Reply URL or Single sign-on URL. Use this exact value." },
    { key: "signin", label: "Sign-in URL", value: connection.signInUrl, hint: "Optional. Starts sign-in from OpenWork." },
    { key: "metadata", label: "Metadata URL", value: connection.metadataUrl, hint: "For identity providers that can import service provider metadata." },
  ];
}

export function SsoProviderValues({ connection, copiedValue, onCopy }: {
  connection: DenOrgSsoConnection;
  copiedValue: string | null;
  onCopy: (value: string | null, key: string) => void;
}) {
  return (
    <section data-testid="sso-provider-setup" aria-label="Identity provider setup values" className="divide-y divide-[var(--dls-border)]">
      {getSsoSetupValues(connection).map((row) => (
        <div key={row.key} data-sso-value={row.key} className="py-4 first:pt-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-[var(--dls-text-primary)]">{row.label}</p>
              <p className="mt-1 text-[12px] leading-5 text-[var(--dls-text-secondary)]">{row.hint}</p>
            </div>
            <DenButton size="sm" variant="secondary" icon={Copy} aria-label={`Copy ${row.label}`} onClick={() => onCopy(row.value, row.key)} disabled={!row.value}>{copiedValue === row.key ? "Copied" : "Copy"}</DenButton>
          </div>
          <code className="mt-2 block break-words text-[13px] leading-6 text-[var(--dls-text-primary)]">{row.value ?? "Not applicable"}</code>
        </div>
      ))}
    </section>
  );
}
