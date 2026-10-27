import type { Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/**
 * The real app in headless Chrome, signed in to a Den whose organization does
 * not have every-few-hours schedules yet. The world turns the feature on the
 * way a platform admin does, from /admin.
 */
export async function automationIntervalSchedulesWorld(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed, { org: { name: "Interval schedules workspace", admin: { name: "Workspace Owner" } } });
  const { app } = await signedInAppWeb(seed, {
    name: "automation-interval-schedules", den, webPort, headless: true,
    workspacePath: seed.tmpPath("automation-interval-schedules"),
  });
  return {
    app,
    async turnOnIntervalSchedules() {
      await enableOrganizationCapabilities(seed, den.admin, { automationIntervalSchedules: true });
    },
  };
}
