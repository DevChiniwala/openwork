import { expect } from "vitest";
import { server, test } from "@openwork/testkit";
import { z } from "zod";

const connectionPayload = z.object({ connection: z.object({
  providerId: z.string(), kind: z.literal("oidc"), redirectUrl: z.string().url(),
  acsUrl: z.null(), metadataUrl: z.null(), domainVerified: z.boolean(), status: z.literal("disabled"),
}) });

for (const split of [false, true]) {
  test(`displayed OIDC callback equals Better Auth's emitted redirect_uri (${split ? "split" : "single"} origin)`, async ({ place }) => {
    const web = "https://ow.ai.example.test";
    const api = split ? "https://api-ow.ai.example.test" : web;
    // Exercise the real Den routes and installed Better Auth plugin. The authorize
    // URL is generated normally but never opened; no external IdP or secret is used.
    await using den = await server({ place, web: false, publicOrigins: { web, api }, org: {
      name: "Example Workspace", admin: { name: "Example Admin", email: "admin@example.test" }, members: {},
    } });
    const login = await fetch(`${den.ref.apiUrl}/api/auth/sign-in/email`, {
      method: "POST", headers: { "content-type": "application/json", origin: den.ref.webUrl },
      body: JSON.stringify({ email: den.admin.email, password: den.admin.password }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const headers = { cookie, authorization: `Bearer ${den.admin.token}`, "content-type": "application/json" };
    const saved = await fetch(`${den.ref.apiUrl}/v1/sso/oidc`, { method: "POST", headers, body: JSON.stringify({
      issuer: "http://127.0.0.1:19876", domain: "example.test", clientId: "example-client", clientSecret: "not-a-real-secret",
      skipDiscovery: true, authorizationEndpoint: "https://idp.example.test/authorize", tokenEndpoint: "https://idp.example.test/token", jwksEndpoint: "https://idp.example.test/jwks",
    }) });
    expect(saved.status).toBe(201);
    const read = await fetch(`${den.ref.apiUrl}/v1/sso`, { headers });
    expect(read.status).toBe(200);
    const { connection } = connectionPayload.parse(await read.json());
    expect(connection.domainVerified).toBe(true);
    const intentResponse = await fetch(`${den.ref.apiUrl}/v1/sso/test`, { method: "POST", headers, body: "{}" });
    expect(intentResponse.status).toBe(201);
    const { intentId } = z.object({ intentId: z.string() }).parse(await intentResponse.json());
    try {
      const start = await fetch(`${den.ref.apiUrl}/v1/sso/test/${encodeURIComponent(intentId)}/start`, { method: "POST", headers, body: "{}" });
      expect(start.status).toBe(200);
      const started = z.object({ url: z.string().url() }).parse(await start.json());
      // Retain/assert only the public redirect URI, never OAuth state, nonce or a
      // complete authorization URL. This is the plugin's actual generated URL.
      const emitted = new URL(started.url).searchParams.get("redirect_uri");
      const expected = `${web}/api/auth/sso/callback/${encodeURIComponent(connection.providerId)}`;
      expect(emitted).toBe(expected);
      expect(connection.redirectUrl).toBe(emitted);
      expect(new URL(connection.redirectUrl).pathname).not.toContain("/saml2/");
      if (split) expect(new URL(connection.redirectUrl).origin).not.toBe(api);
    } finally {
      const canceled = await fetch(`${den.ref.apiUrl}/v1/sso/test/${encodeURIComponent(intentId)}/cancel`, { method: "POST", headers, body: "{}" });
      expect(canceled.status).toBe(204);
    }
  });
}
