"use client";

import { getRequestError } from "../../_lib/den-flow";

export function getEmailDomain(email: string | null | undefined): string | null {
  const value = email?.trim().toLowerCase();
  const at = value?.lastIndexOf("@");
  return value && at !== undefined && at > 0 && at < value.length - 1 ? value.slice(at + 1) : null;
}

export function getSsoDomainWarning(domain: string, issuer: string, adminEmails: string[]): string | null {
  const normalized = domain.trim().toLowerCase();
  const knownDomains = adminEmails.map(getEmailDomain).filter(value => value !== null);
  if (!normalized || knownDomains.includes(normalized)) return null;
  if (knownDomains.length > 0) {
    return `The connection was saved, but no workspace owner or admin email uses ${normalized}. Check that this is your users' email domain before enabling SSO.`;
  }
  let issuerHost: string | null = null;
  try { issuerHost = new URL(issuer).hostname.toLowerCase(); } catch { /* An invalid issuer is handled by the existing save validation. */ }
  if (normalized.endsWith(".onmicrosoft.com") || (issuerHost && normalized.includes(issuerHost))) {
    return `The connection was saved, but ${normalized} looks like an identity provider domain. Check that this is your users' email domain before enabling SSO.`;
  }
  return null;
}

export function getSsoRequestError(payload: unknown, response: Response, fallback: string) {
  const error = getRequestError(payload, response, fallback);
  if (response.status === 409 && typeof payload === "object" && payload !== null && "error" in payload && payload.error === "single_org_mode") {
    return new Error(`${error.message} Sign out and sign back in, then try again.`);
  }
  return error;
}

export function SsoDomainField({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
  return (
    <label className="block text-[14px] text-gray-700">
      <span className="mb-2 block font-medium">Users&apos; email domain</span>
      <input className="w-full rounded-[18px] border border-gray-200 px-4 py-3" value={value} onChange={event => onChange(event.target.value)} placeholder="example.com" disabled={disabled} />
      <span className="mt-1 block text-[12px] text-gray-500">The domain after the @ in your users&apos; email addresses, e.g. example.com. Not your identity provider&apos;s tenant domain.</span>
    </label>
  );
}

export function SsoAdvancedAudience({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
  return (
    <details className="text-[14px] text-gray-700 md:col-span-2">
      <summary className="cursor-pointer font-medium">Advanced</summary>
      <label className="mt-4 block">
        <span className="mb-2 block font-medium">Audience URL</span>
        <input className="w-full rounded-[18px] border border-gray-200 px-4 py-3" value={value} onChange={event => onChange(event.target.value)} placeholder="Defaults to the OpenWork auth URL" disabled={disabled} />
        <span className="mt-1 block text-[12px] text-gray-500">Leave blank to use the Entity ID shown above.</span>
      </label>
    </details>
  );
}

export function SsoEnableWarning() {
  return <p className="mt-2 pr-8 text-[14px] leading-6 text-slate-600">Once enabled, email and password sign-in stops for everyone in this workspace, including you. Keep this admin session open until you have signed in with SSO.</p>;
}
