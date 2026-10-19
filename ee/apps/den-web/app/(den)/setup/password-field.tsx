"use client";

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@openwork/types/den/password-policy";

export function SetupPasswordField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <>
      <label className="den-label" htmlFor="setup-password">Password</label>
      <input
        id="setup-password"
        name="password"
        type="password"
        autoComplete="new-password"
        className="den-input"
        value={value}
        onChange={event => onChange(event.currentTarget.value)}
        minLength={MIN_PASSWORD_LENGTH}
        maxLength={MAX_PASSWORD_LENGTH}
        aria-describedby="setup-password-policy"
        required
      />
      <p id="setup-password-policy" className="m-0 text-xs leading-5 text-[var(--dls-text-secondary)]">
        Use {MIN_PASSWORD_LENGTH}–{MAX_PASSWORD_LENGTH} characters.
      </p>
    </>
  );
}
