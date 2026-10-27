import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { AUTO_ROUTER_MODEL_ID, AUTO_ROUTER_RESPONSE_MODEL_HEADER, AUTO_ROUTER_RESPONSE_REASON_HEADER } from "@openwork/types/den/auto-router";
import { ACME_MODEL, ACME_REPLY } from "../../worlds/lib/acme-gateway.ts";
import { autoRouterWorld } from "../worlds/auto-router.ts";
import { isRecord } from "./../worlds/library.ts";

const test = spec.world(autoRouterWorld, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

test("an admin enables the Auto Router and Auto answers through the chosen Gateway model", async ({ world, user, probe, step, evidence }) => {
  await step("before: the AI Providers tab offers the Auto Router above Providers", async () => {
    await user.see({ testId: "auto-router-section" }, { timeoutMs: 60_000 });
    await user.see({ text: "Auto Router" });
    await user.see({ testId: "auto-router-enable" });
    const connect = await probe.api(world.den.admin, "/v1/org/auto-router/connect");
    expect(connect.response.status).toBe(404);
    evidence.recordAssertionEvidence("desktops get no Auto before it is configured", `connect HTTP ${connect.response.status}`, connect.response.status === 404);
    await user.screenshot();
  });

  await step("an admin enables it and saves a route with two thinking levels", async () => {
    await user.click({ testId: "auto-router-enable" });
    await user.see({ testId: "auto-router-editor" }, { timeoutMs: 30_000 });
    await user.see({ role: "combobox", label: "Model" }, { value: world.provider.modelName.replace(/ \(.*\)$/, ""), timeoutMs: 30_000 });
    const levels = await probe.dom('[data-testid^="auto-router-thinking-"]');
    const offered = levels.elements.map((entry) => entry.text);
    if (offered.includes("High")) await user.click({ testId: "auto-router-thinking-high" });
    await user.type({ testId: "auto-router-prompt" }, "Everyday questions, small edits and short answers");
    await user.screenshot();
    await user.click({ testId: "auto-router-save-route" });
    await user.see({ testId: "auto-router-route" }, { timeoutMs: 30_000 });
    const saved = await probe.api(world.den.admin, "/v1/org/auto-router");
    const routes = isRecord(saved.body) && Array.isArray(saved.body.routes) ? saved.body.routes.filter(isRecord) : [];
    expect(saved.response.ok).toBe(true);
    expect(isRecord(saved.body) && saved.body.enabled).toBe(true);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.modelId).toBe(ACME_MODEL);
    expect(routes[0]?.prompt).toBe("Everyday questions, small edits and short answers");
    const thinking = Array.isArray(routes[0]?.thinkingLevels) ? routes[0].thinkingLevels : [];
    expect(thinking).toContain("default");
    evidence.recordAssertionEvidence("the route is stored with its prompt, model and thinking levels", `offered=${offered.join("/")}; stored model=${String(routes[0]?.modelId)} levels=${thinking.join(",")}`, routes.length === 1 && routes[0]?.modelId === ACME_MODEL);
    await user.screenshot();
  });

  await step("after: Auto routes a chat request to the configured model through the Gateway", async () => {
    const connect = await probe.api(world.den.admin, "/v1/org/auto-router/connect");
    const body = isRecord(connect.body) ? connect.body : {};
    expect(connect.response.ok).toBe(true);
    expect(body.baseURL).toBe(`${world.gatewayUrl}/api/v1`);
    const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
    expect(apiKey.startsWith("ow_gw_")).toBe(true);
    const before = world.upstream.requests.length;
    const response = await fetch(`${world.gatewayUrl}/api/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "x-opencode-session-id": "ses_auto_router_proof" },
      body: JSON.stringify({ model: AUTO_ROUTER_MODEL_ID, stream: true, messages: [{ role: "user", content: "What's the capital of France?" }] }),
    });
    const text = await response.text();
    const routedModel = response.headers.get(AUTO_ROUTER_RESPONSE_MODEL_HEADER);
    const reason = response.headers.get(AUTO_ROUTER_RESPONSE_REASON_HEADER);
    expect(response.status).toBe(200);
    expect(routedModel).toBe(ACME_MODEL);
    expect(text).toContain(ACME_REPLY.split(" ")[0]);
    expect(text).toContain("data: [DONE]");
    expect(text).toContain("\"openwork_route\"");
    const upstreamCalls = world.upstream.requests.slice(before);
    expect(upstreamCalls.map((entry) => entry.model)).toEqual([ACME_MODEL]);
    evidence.recordAssertionEvidence(
      "Auto was answered by the configured model as if picked by hand",
      `HTTP ${response.status}; routed=${routedModel}; reason=${reason}; jev configured=${world.jev}; upstream models=${upstreamCalls.map((entry) => entry.model).join(",")}`,
      response.status === 200 && routedModel === ACME_MODEL && upstreamCalls.length === 1,
    );
  });
});
