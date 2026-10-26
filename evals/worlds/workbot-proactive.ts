import { queryDenDatabase, type Seed } from "@openwork/env";
import { healthFixture } from "./den-service-readiness.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

/** A fixed, valid TypeID for the seeded connection. */
const SLACK_CONNECTION_ID = "emc_01k8z5wq0s0000000000000000";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Den with Workbot deployed here (DEN_WORKBOT_URL), a configured headless runner (the readiness fixture: it answers
 * health checks and nothing else), `workbotProactive` on for one organization, and a Slack connection in Connectors
 * that points at Slack's MCP server (each person signs in; nobody has). No calendar, model or Slack is reached: the
 * admin settings, member settings and their locks are real, and nothing is ever sent.
 */
export async function workbotProactiveWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const runner = stack.use(await healthFixture());
    const den = await seed.den({
      org: {
        name: "Agent settings",
        admin: { name: "Workspace Owner" },
        members: { member: { name: "Workspace Member" } },
      },
      env: {
        DEN_WORKBOT_URL: "http://localhost:3020",
        DEN_HEADLESS_RUNNER_URL: runner.url,
        DEN_HEADLESS_RUNNER_TOKEN: "readiness-fixture-service-token-not-production",
      },
    });
    const organizationId = await enableOrganizationCapabilities(seed, den.admin, { workbotProactive: true });
    const context = await seed.api(den.admin, "/v1/org");
    const currentMember = isRecord(context.body) && isRecord(context.body.currentMember) ? context.body.currentMember : null;
    const ownerMemberId = typeof currentMember?.id === "string" ? currentMember.id : "";
    const databaseUrl = den.database?.url;
    if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_") || !ownerMemberId) throw new Error("The Slack connection fixture needs a disposable testkit database and the owner's membership.");
    await queryDenDatabase(
      databaseUrl,
      "INSERT INTO external_mcp_connection (id, organization_id, name, url, auth_type, credential_mode, created_by_org_membership_id) VALUES (?, ?, 'Slack', 'https://mcp.slack.com/mcp', 'oauth', 'per_member', ?)",
      [SLACK_CONNECTION_ID, organizationId, ownerMemberId],
    );
    const viewport = { width: 1280, height: 1400, deviceScaleFactor: 1 };
    const owner = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/workbot-settings", headless: true, viewport });
    const member = await seed.web({ den, signedInAs: den.members.member, startPath: "/dashboard", headless: true, viewport });
    return { den, owner, member, slackConnectionId: SLACK_CONNECTION_ID, async [Symbol.asyncDispose]() { await stack.disposeAsync(); } };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
