"use client";

import { Copy } from "lucide-react";
import { useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenSelect } from "../../_components/ui/select";
import type { DenOrgSsoConnection } from "../../_lib/den-org";

// Local comparison switch; remove the unselected design after visual review.
export const SAML_SETUP_DESIGN: "a" | "b" = "a";
export type SamlIdp = "entra" | "okta" | "other";
export type SsoSetupMode = "saml" | "oidc";

type SetupValue = { key: string; label: string; value: string | null; hint: string };

export function getSamlEntityId(connection: DenOrgSsoConnection): string | null {
  if (connection.saml?.audience) return connection.saml.audience;
  // The API generates the ACS URL on the auth/web origin, which is also
  // the default SP audience. Do not use the API-host OIDC callback origin.
  if (!connection.acsUrl) return null;
  try {
    return new URL(connection.acsUrl).origin;
  } catch {
    return null;
  }
}

export function getSsoSetupValues(connection: DenOrgSsoConnection, mode: SsoSetupMode, design: "a" | "b", idp: SamlIdp): SetupValue[] {
  if (mode === "oidc") {
    return [
      { key: "signin", label: "Sign-in URL", value: connection.signInUrl, hint: "" },
      { key: "redirect", label: "Redirect URL", value: connection.redirectUrl, hint: "" },
    ];
  }

  const labels = design === "a" || idp === "entra"
    ? { entity: "Identifier (Entity ID)", acs: "Reply URL (Assertion Consumer Service URL)", signin: "Sign on URL" }
    : idp === "okta"
      ? { entity: "Audience URI (SP Entity ID)", acs: "Single sign-on URL", signin: "SP-initiated sign-in URL" }
      : { entity: "SP Entity ID", acs: "ACS URL", signin: "SP-initiated sign-in URL" };
  const hints = design === "a"
    ? { entity: "Microsoft Entra: Basic SAML Configuration > Identifier (Entity ID)", acs: "Microsoft Entra: Basic SAML Configuration > Reply URL", signin: "Microsoft Entra: Basic SAML Configuration > Sign on URL" }
    : idp === "entra"
      ? { entity: "Basic SAML Configuration > Identifier (Entity ID)", acs: "Basic SAML Configuration > Reply URL", signin: "Basic SAML Configuration > Sign on URL" }
      : idp === "okta"
        ? { entity: "Configure SAML > SAML Settings > Audience URI (SP Entity ID)", acs: "Configure SAML > SAML Settings > Single sign-on URL", signin: "Launch OpenWork here. No equivalent Okta setup field verified." }
        : { entity: "The service provider identifier sent as the SAML audience.", acs: "Where your identity provider sends the SAML response.", signin: "Start sign-in from OpenWork; IdP-initiated sign-in is not supported." };
  const entity: SetupValue = { key: "entity", label: labels.entity, value: getSamlEntityId(connection), hint: hints.entity };
  const acs: SetupValue = { key: "acs", label: labels.acs, value: connection.acsUrl, hint: hints.acs };
  // Okta's wizard asks for the ACS before the audience; Entra asks for the identifier first.
  return [
    ...(design === "b" && idp === "okta" ? [acs, entity] : [entity, acs]),
    { key: "signin", label: labels.signin, value: connection.signInUrl, hint: hints.signin },
    { key: "metadata", label: "Metadata URL", value: connection.metadataUrl, hint: "Service provider metadata for your identity provider." },
  ];
}

export function SsoProviderValues({ connection, mode, onModeChange, copiedValue, onCopy, design = SAML_SETUP_DESIGN }: {
  connection: DenOrgSsoConnection;
  mode: SsoSetupMode;
  onModeChange: (mode: SsoSetupMode) => void;
  copiedValue: string | null;
  onCopy: (value: string | null, key: string) => void;
  design?: "a" | "b";
}) {
  const [idp, setIdp] = useState<SamlIdp>("entra");
  const values = getSsoSetupValues(connection, mode, design, idp);
  return (
    <section data-testid="sso-provider-setup" aria-label="Identity provider setup values">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Provider setup protocol" className="flex gap-2">
          <DenButton size="sm" variant={mode === "saml" ? "primary" : "secondary"} aria-pressed={mode === "saml"} onClick={() => onModeChange("saml")}>SAML</DenButton>
          <DenButton size="sm" variant={mode === "oidc" ? "primary" : "secondary"} aria-pressed={mode === "oidc"} onClick={() => onModeChange("oidc")}>OIDC</DenButton>
        </div>
        {mode === "saml" && design === "b" ? (
          <DenSelect aria-label="SAML identity provider" value={idp} onChange={(event) => {
            const value = event.target.value;
            if (value === "entra" || value === "okta" || value === "other") setIdp(value);
          }}>
            <option value="entra">Microsoft Entra</option>
            <option value="okta">Okta</option>
            <option value="other">Other SAML</option>
          </DenSelect>
        ) : null}
      </div>
      <div className="divide-y divide-[var(--dls-border)]">
        {values.map((row) => (
          <div key={row.key} data-sso-value={row.key} className="py-4 first:pt-0">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-[var(--dls-text-primary)]">{row.label}</p>
                {row.hint ? <p className="mt-1 text-[12px] leading-5 text-[var(--dls-text-secondary)]">{row.hint}</p> : null}
              </div>
              <DenButton size="sm" variant="secondary" icon={Copy} aria-label={`Copy ${row.label}`} onClick={() => onCopy(row.value, row.key)} disabled={!row.value}>{copiedValue === row.key ? "Copied" : "Copy"}</DenButton>
            </div>
            <code className="mt-2 block break-words text-[13px] leading-6 text-[var(--dls-text-primary)]">{row.value ?? "Not applicable"}</code>
          </div>
        ))}
      </div>
      {mode === "saml" ? <p className="mt-2 text-[12px] leading-5 text-[var(--dls-text-secondary)]">Use these values for SAML. The OIDC redirect URL is on the OIDC tab.</p> : null}
    </section>
  );
}
