import { describe, expect, test } from "bun:test";

import { checkDesktopAppRestriction, isDesktopProviderBlocked } from "../src/app/cloud/desktop-app-restrictions";

// removeOpencodeZen retires OpenCode Zen (Big Pickle and other free `opencode`
// models). It must block Zen through the one restriction every surface reads,
// signed in (desktop config) or signed out (deployment feature), even while
// organization desktop-policy enforcement is off.
describe("removeOpencodeZen", () => {
  const blocked = (input: Parameters<typeof checkDesktopAppRestriction>[0]) =>
    isDesktopProviderBlocked({ providerId: "opencode", checkRestriction: ({ restriction }) => checkDesktopAppRestriction({ ...input, restriction }) });

  test("Zen stays available while the feature is off", () => {
    expect(checkDesktopAppRestriction({ config: {}, restriction: "allowZenModel" })).toBe(false);
    expect(checkDesktopAppRestriction({ config: null, restriction: "allowZenModel", opencodeZenRemoved: false })).toBe(false);
    expect(blocked({ config: { removeOpencodeZen: false }, restriction: "allowZenModel" })).toBe(false);
  });

  test("signed in, the organization's desktop config removes Zen", () => {
    expect(checkDesktopAppRestriction({ config: { removeOpencodeZen: true }, restriction: "allowZenModel" })).toBe(true);
    expect(blocked({ config: { removeOpencodeZen: true }, restriction: "allowZenModel" })).toBe(true);
  });

  test("signed out, the deployment feature removes Zen", () => {
    expect(checkDesktopAppRestriction({ config: null, restriction: "allowZenModel", opencodeZenRemoved: true })).toBe(true);
    expect(blocked({ config: null, restriction: "allowZenModel", opencodeZenRemoved: true })).toBe(true);
  });

  test("only Zen is affected", () => {
    const config = { removeOpencodeZen: true };
    expect(checkDesktopAppRestriction({ config, restriction: "allowCustomProviders" })).toBe(false);
    expect(isDesktopProviderBlocked({ providerId: "openai", checkRestriction: ({ restriction }) => checkDesktopAppRestriction({ config, restriction }) })).toBe(false);
  });
});
