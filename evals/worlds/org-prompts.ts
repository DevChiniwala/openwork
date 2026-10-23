import type { Place, Seed } from "@openwork/env";
import { engineParity } from "./engine-parity.ts";
import { isRecord, records } from "./library.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

export const EVERYONE_PROMPT = "Write for non-technical readers. Never share customer names outside the organization.";
export const DESIGN_PROMPT = "Follow the brand guide in the Design folder and export images as PNG.";

/**
 * An organization Avery owns with Prompts on, Riley in the Design team, and a
 * prompt for everyone already saved. Avery is on the Design team's Prompts
 * tab, where Design has no prompt of its own yet.
 */
export async function orgPromptsTeamTab(seed: Seed) {
  const den = await seed.den({
    web: true,
    org: {
      name: `Prompts ${Date.now()}`,
      admin: { name: "Avery Owner" },
      members: { riley: { name: "Riley Designer" } },
    },
  });
  const riley = den.members.riley;
  if (!riley) throw new Error("seed.den() did not provision Riley's session");
  const organizationId = await enableOrganizationCapabilities(seed, den.admin, { orgPrompts: true });
  const scope = { "x-openwork-org-id": organizationId };

  const org = await seed.api(riley, "/v1/org");
  const member = isRecord(org.body) && isRecord(org.body.currentMember) ? org.body.currentMember : null;
  if (!org.response.ok || typeof member?.id !== "string") throw new Error(`Reading Riley's membership failed: ${org.text.slice(0, 500)}`);
  const team = await seed.api(den.admin, "/v1/teams", { method: "POST", headers: scope, body: JSON.stringify({ name: "Design", memberIds: [member.id] }) });
  const teamId = isRecord(team.body) && isRecord(team.body.team) ? team.body.team.id : null;
  if (!team.response.ok || typeof teamId !== "string") throw new Error(`Creating Design failed: ${team.text.slice(0, 500)}`);

  const saved = await seed.api(den.admin, "/v1/org/prompts/everyone", { method: "PUT", headers: scope, body: JSON.stringify({ content: EVERYONE_PROMPT }) });
  if (!saved.response.ok) throw new Error(`Saving the prompt for everyone failed: HTTP ${saved.response.status} ${saved.text.slice(0, 500)}`);

  const viewport = { width: 1440, height: 1500 };
  const web = await seed.web({
    den, signedInAs: den.admin, headless: true, viewport,
    startPath: `/dashboard/members/teams/${encodeURIComponent(teamId)}?tab=prompts`,
  });

  return {
    den,
    teamId,
    web,
    everyoneUrl: new URL("/dashboard/members/teams/everyone?tab=prompts", den.ref.webUrl).toString(),
    /** The prompts Riley's desktop receives with its provider sync, in the order it appends them. */
    async rileyPrompts() {
      const read = await seed.api(riley, "/v1/me/prompts");
      if (!read.response.ok || !isRecord(read.body)) throw new Error(`Reading Riley's prompts failed: HTTP ${read.response.status}`);
      return records(read.body.prompts).map((entry) => ({ source: entry.source, teamName: entry.teamName ?? null, content: entry.content }));
    },
  };
}

export const REVISED_DESIGN_PROMPT = "Follow the brand guide in the Design folder and export images as SVG.";

/**
 * Riley, in the Design team, chatting in the real app (in a browser) signed in
 * to a real Den with Prompts on and prompts saved for everyone and for Design.
 * The model is scripted; it records whether each request carried the
 * organization's prompts in OpenWork's instructions, without keeping them.
 */
export async function orgPromptsDesktop(seed: Seed, context: { place: Place }) {
  await using setup = new AsyncDisposableStack();
  const den = await seed.den({
    web: true,
    org: { name: `Prompts desktop ${Date.now()}`, admin: { name: "Avery Owner" }, members: { riley: { name: "Riley Designer" } } },
  });
  const riley = den.members.riley;
  if (!riley) throw new Error("seed.den() did not provision Riley's session");
  const organizationId = await enableOrganizationCapabilities(seed, den.admin, { orgPrompts: true });
  const scope = { "x-openwork-org-id": organizationId };
  const org = await seed.api(riley, "/v1/org");
  const member = isRecord(org.body) && isRecord(org.body.currentMember) ? org.body.currentMember : null;
  if (!org.response.ok || typeof member?.id !== "string") throw new Error(`Reading Riley's membership failed: ${org.text.slice(0, 500)}`);
  const team = await seed.api(den.admin, "/v1/teams", { method: "POST", headers: scope, body: JSON.stringify({ name: "Design", memberIds: [member.id] }) });
  const teamId = isRecord(team.body) && isRecord(team.body.team) ? team.body.team.id : null;
  if (!team.response.ok || typeof teamId !== "string") throw new Error(`Creating Design failed: ${team.text.slice(0, 500)}`);
  async function savePrompt(path: string, content: string) {
    const saved = await seed.api(den.admin, path, { method: "PUT", headers: scope, body: JSON.stringify({ content }) });
    if (!saved.response.ok) throw new Error(`Saving ${path} failed: HTTP ${saved.response.status} ${saved.text.slice(0, 500)}`);
  }
  await savePrompt("/v1/org/prompts/everyone", EVERYONE_PROMPT);
  await savePrompt(`/v1/org/prompts/teams/${encodeURIComponent(teamId)}`, DESIGN_PROMPT);

  const base = setup.use(await engineParity(seed, context, { env: {
    OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1", OPENWORK_DEV_DEN_PROXY_TARGET: den.ref.webUrl,
    OPENWORK_DEV_HEADLESS_DEN_API_TARGET: den.ref.apiUrl,
    VITE_DEN_BASE_URL: den.ref.webUrl, VITE_DEN_API_BASE_URL: "/api/den",
  } }));
  await seed.signIn(base.app, riley, "Riley Designer");
  // Same owned-runtime handoff as other app-in-a-browser worlds: renderer
  // sign-in alone does not establish the server's Den session the desktop
  // shell pushes (PUT /den-session), which provider sync runs on.
  const linked = await base.hostRequest("/den-session", "PUT", { baseUrl: den.ref.apiUrl, token: riley.token, orgId: organizationId });
  if (linked.status >= 300) throw new Error(`Den session handoff failed: HTTP ${linked.status}`);

  async function expectInRequests(text: string) {
    const response = await fetch(`${base.mock.url}/admin/private-sentinels`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ values: [text] }),
    });
    if (!response.ok) throw new Error(`Model witness setup failed: ${response.status}`);
  }

  const owned = setup.move();
  return {
    ...base,
    den,
    async [Symbol.asyncDispose]() { await owned.disposeAsync(); },
    /** Runs one provider sync pass on Riley's OpenWork, as sign-in, focus and the interval do. */
    async sync() {
      const result = await base.hostRequest("/cloud-provider-sync/run", "POST", { reason: "manual" });
      return isRecord(result.body) ? result.body.status : result.status;
    },
    /**
     * Watch later model requests for one line of text. Each engine escapes the
     * instructions differently inside the request, so watched text is a
     * single line with no characters that need escaping.
     */
    watchFor: (text: string) => expectInRequests(text),
    /** Whether a model request answering `promptMarker` carried the watched text. */
    async modelSawWatched(promptMarker: string) {
      const requests = await base.mock.agentRequests({ promptMarker, atLeast: 1, timeoutMs: 60_000 });
      return requests.some((request) => request.privateSentinelSeen === true);
    },
    reviseDesignPrompt: () => savePrompt(`/v1/org/prompts/teams/${encodeURIComponent(teamId)}`, REVISED_DESIGN_PROMPT),
    async turnPromptsOff() {
      const result = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
        method: "PUT", body: JSON.stringify({ capabilities: { orgPrompts: false } }),
      });
      if (!result.response.ok) throw new Error(`Turning Prompts off failed: HTTP ${result.response.status}`);
    },
  };
}
