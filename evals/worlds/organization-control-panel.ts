import type { Seed } from "@openwork/env";
import { organizationControlPanelSchema } from "@openwork/types/den/organization-grants";
import { seededOrganizationId } from "./organization-capabilities.ts";

export async function organizationControlPanelWorld(seed: Seed) {
  const den = await seed.den({ web: true, env: { INFERENCE_FREE_ENABLED: "true", GATEWAY_ENABLED: "true", GATEWAY_PUBLIC_BASE_URL: "http://127.0.0.1:8791", GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:8791" },
    org: { name: "Control panel workspace", admin: { name: "Platform administrator" }, members: { member: { name: "Organization member" } } } });
  const organizationId = await seededOrganizationId(seed, den.admin);
  if (!organizationId) throw new Error("The control panel organization was not created.");
  const path = `/admin/organizations/${organizationId}/control-panel`;
  const apiPath = `/v1/admin/organizations/${organizationId}/control-panel`;
  const viewport = { width: 1280, height: 900 };
  const admin = await seed.web({ den, signedInAs: den.admin, startPath: path, headless: true, viewport });
  const member = await seed.web({ den, signedInAs: den.members.member, startPath: path, headless: true, viewport });
  const anonymous = await seed.web({ den, startPath: path, headless: true, viewport });
  return {
    admin, member, anonymous,
    async panel(history = false) {
      const result = await seed.api(den.admin, `${apiPath}?history=${history ? "1" : "0"}`);
      if (!result.response.ok) throw new Error(`Control panel read failed (${result.response.status}).`);
      return organizationControlPanelSchema.parse(result.body);
    },
    async memberAccess() {
      const read = await seed.api(den.members.member, apiPath);
      const write = await seed.api(den.members.member, `${apiPath}/access`, { method: "PUT", body: JSON.stringify({ feature: "freeAuto", setting: "enabled" }) });
      return { read: read.response.status, write: write.response.status };
    },
  };
}
