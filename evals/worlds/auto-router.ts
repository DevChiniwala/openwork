import type { Seed } from "@openwork/env";
import { gatewayEnvironment, seedAcmeGateway, startAcmeGateway, startAcmeUpstream } from "../../worlds/lib/acme-gateway.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

/**
 * Auto Router: a real Den (cloud deployment, `autoRouter` on for the seeded
 * organization), a real AI Gateway with one Anthropic-protocol provider whose
 * only upstream is the deterministic Acme mock, and the owner signed in on
 * AI Gateway › AI Providers. Jev is real when TYPESAFE_API_KEY is set in the
 * test's environment; otherwise Auto takes its fallback route.
 */
export async function autoRouterWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const upstream = await startAcmeUpstream(stack);
    const gateway = await gatewayEnvironment(upstream.baseUrl);
    const typesafe = process.env.TYPESAFE_API_KEY?.trim();
    const env = { ...gateway.env, DEN_DEPLOYMENT: "cloud", ...(typesafe ? { TYPESAFE_API_KEY: typesafe } : {}) };
    const den = stack.use(await seed.den({ env, org: { name: "Auto Router proof", admin: { name: "Router owner" } } }));
    if (!den.database) throw new Error("The Auto Router world needs its disposable local database.");
    await startAcmeGateway(stack, den.database.url, { baseUrl: gateway.baseUrl, env });
    const provider = await seedAcmeGateway(den.admin, upstream);
    const organizationId = await enableOrganizationCapabilities(seed, den.admin, { autoRouter: true });
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/ai-gateway?tab=ai-providers", headless: true, viewport: { width: 1440, height: 1100 } });
    return {
      den,
      web,
      organizationId,
      provider,
      gatewayUrl: gateway.baseUrl,
      upstream,
      jev: Boolean(typesafe),
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
