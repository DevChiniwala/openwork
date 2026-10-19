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
      { key: "redirect", label: "Redirect URL", value: connection.redirectUrl, hint: "Also called Redirect URI." },
    ];
  }
  return [
    { key: "entity", label: "Entity ID", value: getSamlEntityId(connection), hint: "Also called Identifier or Audience URI." },
    { key: "acs", label: "ACS URL (Reply URL)", value: connection.acsUrl, hint: "Where your identity provider sends users back after sign-in. Also called Reply URL, Single sign-on URL or Assertion Consumer Service URL." },
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
    <section data-testid="sso-provider-setup" aria-label="Identity provider setup values" className="space-y-4">
      <p className="text-[16px] font-semibold tracking-[-0.03em] text-gray-900">Give these values to your identity provider</p>
      {getSsoSetupValues(connection).map((row) => (
        <div key={row.key} data-sso-value={row.key} className="rounded-[20px] border border-gray-200 bg-gray-50 p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-[13px] font-semibold uppercase tracking-[0.12em] text-gray-500">{row.label}</p>
            <DenButton variant="secondary" icon={Copy} aria-label={`Copy ${row.label}`} onClick={() => onCopy(row.value, row.key)} disabled={!row.value}>{copiedValue === row.key ? "Copied" : "Copy"}</DenButton>
          </div>
          <code className="block break-all text-[13px] leading-6 text-gray-700">{row.value ?? "Not applicable"}</code>
          <p className="mt-1 text-[12px] text-gray-500">{row.hint}</p>
        </div>
      ))}
    </section>
  );
}
