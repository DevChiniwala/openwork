/**
 * Optional model for a workshop org: when OPENAI_API_KEY is in this process's
 * environment, add it once as an org AI Gateway provider for every member and
 * cap each member with a daily usage-limit policy. The key goes only to Den's
 * encrypted provider store; it is never logged, echoed or written to outputs.
 */
import { denFetch } from "../../evals/packages/behaviors/src/den.ts";
import type { DenSession } from "../../evals/packages/behaviors/src/den.ts";
import { redact } from "./workshop-plan.ts";

export type WorkshopModelResult = { state: "provisioned" | "skipped" | "failed"; note: string; providerId?: string; policyId?: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(body: unknown): string {
  return record(body) && typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? ` (${body.error})` : "";
}

export async function provisionWorkshopModel(input: {
  admin: DenSession;
  orgId: string;
  model: string;
  allowanceUsd: string;
  /** Whether the Den was booted with its AI Gateway; usage limits require it. */
  gatewayEnabled: boolean;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof denFetch;
}): Promise<WorkshopModelResult> {
  const key = (input.env ?? process.env).OPENAI_API_KEY?.trim();
  if (!key) {
    return { state: "skipped", note: "No OPENAI_API_KEY in this shell, so no model was added. Attendees can still connect and use the five workplace apps; add a provider in Den web or rerun with the key exported." };
  }
  if (!input.gatewayEnabled) return { state: "failed", note: "This Den has no AI Gateway, so a per-member allowance cannot be enforced; no model was added." };
  const fetcher = input.fetcher ?? denFetch;
  const headers = { authorization: `Bearer ${input.admin.token}`, "x-openwork-org-id": input.orgId };
  const created = await fetcher(input.admin, "/v1/inference-providers", {
    method: "POST", headers,
    body: JSON.stringify({ name: "Workshop OpenAI", providerId: "openai", modelIds: [input.model], credential: { kind: "api_key", secret: key }, allMembers: true }),
  }).catch(() => null);
  if (created && JSON.stringify(created.body ?? "").includes(key)) throw new Error("Den echoed the provider credential (value suppressed); refusing to continue.");
  const provider = created && record(created.body) && record(created.body.inferenceProvider) ? created.body.inferenceProvider : undefined;
  if (!created || created.response.status !== 201 || typeof provider?.id !== "string") {
    return { state: "failed", note: redact(`Den did not add the OpenAI provider: ${created ? `HTTP ${created.response.status}${errorCode(created.body)}` : "request failed"}.`, [key]) };
  }
  const providerId = provider.id;
  const policy = await fetcher(input.admin, "/v1/gateway/usage-limit-policies", {
    method: "POST", headers,
    body: JSON.stringify({ name: `Workshop allowance $${input.allowanceUsd}/day`, hardLimit: true, allowRequestReset: true, limits: [{ timeframe: "day", costUsd: input.allowanceUsd }] }),
  });
  const policyId = record(policy.body) && typeof policy.body.id === "string" ? policy.body.id : undefined;
  if (!policy.response.ok || !policyId) {
    return { state: "failed", providerId, note: `OpenAI (${input.model}) is available to every member, but Den refused the usage limit: HTTP ${policy.response.status}${errorCode(policy.body)}. Set one in Den web before attendees start.` };
  }
  const assigned = await fetcher(input.admin, `/v1/gateway/usage-limit-policies/${encodeURIComponent(policyId)}/assignments`, {
    method: "POST", headers, body: JSON.stringify({ organization: true }),
  });
  if (!assigned.response.ok) {
    return { state: "failed", providerId, policyId, note: `OpenAI (${input.model}) is available, but the $${input.allowanceUsd}/day limit could not be assigned to the organization: HTTP ${assigned.response.status}${errorCode(assigned.body)}.` };
  }
  return { state: "provisioned", providerId, policyId, note: `OpenAI ${input.model} through the AI Gateway for every member, capped at $${input.allowanceUsd} per member per day (hard limit; members may request more).` };
}
