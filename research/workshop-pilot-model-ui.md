# Workshop pilot: model access and current UI path

Inspected 2026-10-20, branch `verify/workshop-model-path` (from `feat/workshop-world`). Scope: code/static inspection plus public read-only catalog discovery. **No Daytona runtime result is claimed.** The lead must verify the existing one-backend/one-attendee Daytona pilot; do not scale to 20 before one complete task succeeds.

## Immediate blockers / corrections

1. **Do not guess a missing organization flag.** `GET /v1/inference-providers?scope=usable` is not feature-gated. An ordinary member sees a provider only through an effective grant joining an **active model group and active credential set**, for that member/team/organization. `liveProviderSync` gates v2's live inventory transport, not this list. Check the attendee's response before changing flags.
2. **Use the current picker, not old modal/text selectors:** `button[aria-label="Change model"]` opens `[data-testid="composer-model-picker"]`; search is `[aria-label="Search all models"]`. A Gateway row's model ID is the returned **`gwm_…` alias**, not `gpt-6.1-sol`. Its runtime provider ID is **`ipr_…`**, not `openai`.
3. **No visible Steer button exists in the current composer.** While busy, plain Enter queues; **Ctrl+Enter on Daytona Linux steers immediately**. The circular button is **Stop**, not Send, while busy.
4. `worlds/workshop.ts:166-169` marks the model progress step OK even when provisioning returned `skipped` or `failed`, then boots desktops. A started world is not evidence of an assigned model, enforced allowance, inference access, or completed UI task.
5. **Keep `gpt-6.1-sol`.** It exists in both the checked-in gateway catalog and the live trusted catalog, named **GPT-6.1 Sol**. No alternate model is needed on catalog grounds. Upstream credential entitlement is still unverified.

## Model catalog: what was actually discovered

Den's trusted source is `https://models.openworklabs.com/api.json`, fetched by `ee/apps/den-api/src/llm/models-dev.ts:4,58-125` with a ten-minute in-process cache. Public read during this inspection returned HTTP 200 and:

```json
{
  "provider": "openai",
  "npm": "@ai-sdk/openai",
  "env": ["OPENAI_API_KEY"],
  "model": {
    "id": "gpt-6.1-sol",
    "name": "GPT-6.1 Sol",
    "canonical_model_id": "openai/gpt-6.1-sol",
    "tool_call": true,
    "reasoning": true,
    "reasoning_options": [{"type":"effort","values":["low","medium","high","xhigh","max"]}]
  }
}
```

A local **static JSON read**, not an app launch, independently confirmed `ee/apps/gateway/src/models/base.json` contains the same OpenAI model ID/name/canonical ID/tool capability. `gpt-5.4` also exists, but switching models would not repair audience grants or runtime sync. Catalog existence does not prove a particular paid key can serve the model.

## Exact workshop provisioning contract

`worlds/lib/workshop-model.ts:21-63`:

- No exported `OPENAI_API_KEY`: returns `skipped`; no provider or policy is created.
- Missing AI Gateway URL: returns `failed` before creating a provider.
- Otherwise uses admin session plus `x-openwork-org-id` and the following operations. **Bodies below document the contract, not authorization to run mutations; do not retrieve credentials for this report.**

```text
POST /v1/inference-providers
{
  "name": "Workshop OpenAI",
  "providerId": "openai",
  "modelIds": ["gpt-6.1-sol"],
  "credential": {"kind":"api_key","secret":"<human-provided, never evidence>"},
  "allMembers": true
}

POST /v1/gateway/usage-limit-policies
{
  "name": "Workshop allowance $5/day",
  "hardLimit": true,
  "allowRequestReset": true,
  "limits": [{"timeframe":"day","costUsd":"5"}]
}

POST /v1/gateway/usage-limit-policies/<policyId>/assignments
{"organization":true}
```

No extra OpenAI settings are supplied; default settings are `{}`, provider credential mode defaults to `org`, and status defaults to `active`. Successful provider creation requires HTTP 201 and `inferenceProvider.id`. A policy/assignment failure can leave a usable provider behind **without the promised cap**; do not simply rerun and accumulate duplicate providers.

The provider create route (`ee/apps/den-api/src/routes/org/inference-providers.ts:542-565`) stores the catalog universe, then `defaultMatrix` (`273-292`) creates:

- active **All Allowed Models** group containing supported provider catalog models;
- **Default credentials** set with the supplied shared key;
- organization audience grant because `allMembers:true`.

`modelIds` alone defines the provider's allowed universe; **it grants nobody access**. Likewise pins and organization/workspace defaults do not grant access. A provider seeded outside this helper must have equivalent group/set/grant links.

For an already-existing matrix, the supported assignment operation is:

```text
POST /v1/inference-providers/<ipr-id>/access-grants
{
  "modelGroupId": "<gmg-id from this provider>",
  "credentialSetId": "<gcs-id from this provider>",
  "audience": {"type":"organization"}
}
```

If the group omitted the upstream model, the narrow supported enablement operation is:

```text
POST /v1/inference-providers/<ipr-id>/enable-models
{"modelGroupId":"<gmg-id>","modelIds":["gpt-6.1-sol"]}
```

These are **lead/operator decisions**, not actions performed here. A legacy provider PATCH carrying `allMembers`/credentials is rejected as `matrix_write_required`; edit grants/credential sets instead (`inference-providers.ts:569-575`).

### Deployment settings, permissions and flags

| Item | Exact relevance |
| --- | --- |
| `GATEWAY_ENABLED=true` | Required for Gateway management and usage limits. Absent returns `gateway_not_enabled`; not an org feature. Workshop sets it in `worlds/workshop.ts:59-86`. Gateway proxy/public URLs must resolve to the pilot's own Gateway. |
| `DEN_DB_ENCRYPTION_KEY` | Required by the isolated provider store; workshop supplies its dev-only key. No real key should enter logs/screenshots. |
| `gateway_providers.manage` / `.view` | Admin management write/read permissions. Ordinary member usable list does not require these. Session management writes require recent authentication. |
| `gateway_limits.manage` / `.view` | Policy/assignment management permissions. Member can read `/v1/gateway/usage-limits/me`. |
| `liveProviderSync` | Registry default **false**. Required only for native v2 live inventory ownership and `/inventory/revision` + `/inventory/events`. Legacy mirror path still imports Gateway providers when false. |
| `cloudAgentGateway` | Registry default false. Applies to Workbot/cloud-agent model catalog, **not the local attendee desktop picker**. Not a repair for desktop missing models. |
| `modelsAnalyticsUi` | Analytics UI only; not required for model access or limit API. |
| `secureSecretFields` | Default false; changes secure key-entry workflow, not member visibility. Agents may not submit keys. Human session seed vs agent/API-key context matters (`inference-providers.ts:162-172`). |
| `VITE_DISABLE_OPENWORK_MODELS=0` | Workshop desktop env already sets this. It controls the OpenWork Models promotion, not the custom OpenAI Gateway audience grant. |
| `engineV2ForceUpgrade` / `engineV2Upgrade` | Default false; migration/upgrade controls, not model grants. Inspect actual running engine instead of enabling upgrades to diagnose model visibility. |

Flag source: `packages/features/src/registry.ts:63-97,175-188`. Supported admin route (`ee/apps/den-api/src/routes/admin/index.ts:2117-2207`), **if lead chooses v2 live sync**:

```text
GET /v1/admin/organizations/<orgId>/capabilities
PUT /v1/admin/organizations/<orgId>/capabilities
{"capabilities":{"liveProviderSync":true}}
```

Always inspect returned `capabilities` and `featureStates`: deployment locks (`DEN_FEATURE_LIVE_PROVIDER_SYNC`), kill switches and rollout state can outrank an org override. `gatewayDashboard` is deprecated, always true and ignored on write; do not try to use it as a missing flag. Existing supported fixture: `evals/worlds/organization-capabilities.ts:17-33`.

## Read-only diagnostic sequence on the existing Daytona pilot

Use the lead's existing admin/member sessions privately; do not paste tokens into CDP expressions or evidence. Include `x-openwork-org-id` for the **workshop organization**. Never confuse host and attendee bearer, active org or desktop worker.

1. **Admin management inventory:** `GET /v1/inference-providers?scope=manageable`, then `GET /v1/inference-providers/<ipr-id>`. Check provider active, model group contains `gpt-6.1-sol`, credential set active/configured/ready, access grant audience organization (or the actual attendee/team), and referenced IDs belong to the same provider. Management inventory isn't proof that a member can use it.
2. **Attendee usable inventory:** `GET /v1/inference-providers?scope=usable`. Capture only nonsecret fields: provider ID/name/source/status, `credentialStatus`, `modelAssignmentsComplete`, `models` ID/name/`upstreamModelId`, authorization-request model IDs. Expected source `openwork_gateway`, `credentialStatus:"ready"`, matching model with `upstreamModelId:"gpt-6.1-sol"` and `id:"gwm_…"`.
   - Provider absent: check org/identity, grant audience and active group/set first. No list-level feature gate exists (`inference-providers.ts:467-511`).
   - Provider present but no model: missing org credentials, pending member credentials, group membership/catalog/config incompatibility. `gateway-matrix.ts:505-575` defines the projection. `modelAssignmentsComplete:false` means incomplete representation, **not proven removal**.
   - Member model present: Den audience provisioning is working; continue downstream rather than broadening permissions.
3. **Attendee policy hydration:** `GET /v1/me/desktop-config` exposes `liveProviderSync`, restrictions and optional default (`routes/me/index.ts:364-397`). Also inspect provider block/allow restrictions. Custom-provider restriction still permits cloud-managed `ipr_` providers unless explicitly blocked (`provider-policy.ts:29-44`).
4. **Runtime observations with existing private observer auth:** `GET /experimental/engine-v2-preview/status`, `GET /cloud-provider-sync/status`. If v2, `GET /workspace/<workspaceId>/opencode2/api/model` and `/api/plugin` show model/plugin inventory; project only IDs/status/errors, not credential-bearing options. Existing fixture: `evals/worlds/live-provider-sync.ts:148-164`.
   - Live v2: status must actually report `enabled`, `chatRouting`, `liveProviderSync`. Runtime's managed providers come from the native plugin; legacy sync intentionally skips inference providers. Do not judge live-native success solely by mirrored status rows.
   - Legacy mirror: `apps/server/src/cloud-provider-sync.ts:543-581` reads usable inventory then private connect payload; `server.ts:822-855` chooses ownership from hydrated desktop policy. Broken/absent server-side Den session can leave renderer signed in but runtime inventory empty. Existing workshop-agent fixture explicitly hands the session to its owned server (`evals/worlds/workshop-agent.ts:119-131`); inspect the normal handoff rather than injecting config/localStorage.
   - `GET .../<ipr-id>/connect` can issue a member Gateway key, and is **not needed for this report's read-only inspection**. Do not save its response. Runtime owns this call.
5. **Allowance:** admin policy/assignment reads and attendee `GET /v1/gateway/usage-limits/me`. Organization assignment means independent per-member buckets, including future members, not a pooled $5 org cap (`gateway-usage-limits.ts:41,69-80`). It checks settled spend; concurrent in-flight work can overshoot, so this is not a strict zero-overshoot reservation.

If the seeded provider is **`lpr_…`**, it is the legacy `/v1/llm-providers` family, not this workshop helper's `ipr_…`. `evals/packages/behaviors/src/live-openai.ts` uses that legacy family with `source:"models_dev"` and `allMembers:true`; its helper's default model is `gpt-5.4`, unlike workshop's Sol. Do not mix endpoint families or aliases. Company-provided `source:"openwork"` models additionally have managed-model/DPA policy (`packages/types/src/den/managed-models-policy.ts`); that policy explicitly permits customer-key AI Gateway and does not explain a missing `openwork_gateway` grant.

## Supported current UI path (no layout assumptions)

| Action/witness | Exact current selector or control |
| --- | --- |
| Start a task | UI New task, then verify `/workspace/<workspace-id>/session/<session-id>` and empty ready composer; a URL-only transition is insufficient. |
| Composer | `[contenteditable="true"][data-lexical-editor="true"][role="textbox"]`; ensure exactly the intended focused pane. |
| Open picker | `button[aria-label="Change model"]` |
| Composer popover | `[data-testid="composer-model-picker"]` (not the separate dialog) |
| Search | Inside popover: `[aria-label="Search all models"]`, type `GPT-6.1 Sol` |
| Exact row | Within popover: `[data-model-key="<runtimeProviderId>:<returnedModelAlias>"]`, or `[data-testid="model-option-<runtimeProviderId>-<returnedModelAlias>"]` |
| Selected row | `data-checked="true"` on that row after reopening; composer button displays GPT-6.1 Sol. |
| Initial send | `button[aria-label="Run task"]` enabled; click once, then observe a fresh user message ID and empty draft. |
| Busy stop | `button[aria-label="Stop"]` (English locale); never click as an assumed Send. |
| Busy queue | Plain Enter in focused composer. |
| Busy steer | Ctrl+Enter on Linux in focused composer; inspect immediately to confirm a new user message rather than queue-only UI. |
| Newline | Shift+Enter. |

Code: `apps/app/src/components/model-select.tsx:91-104`; `domains/models/model-picker-list.tsx:175-176,224-230`; `domains/session/surface/composer/editor.tsx:1076-1105`; `composer.tsx:332-354,1463-1485,1518-1583` (all under `apps/app/src/react-app` unless otherwise stated).

The separate `ModelPickerModal` has `data-testid="all-models-picker"`, but the composer uses **Popover + ModelPickerPanel**, not that dialog. Search once to avoid duplicate Pinned/Recent rows; verify uniqueness before clicking. Aliases are derived from group/set/provider-model IDs (`ee/packages/utils/src/gateway-routing.ts:12-16`), not an upstream name. Copy IDs from member inventory/runtime; never fabricate them.

Existing helpers:

- `evals/worlds/live-provider-sync.ts:117-143,163-164` reads the member catalog, checks `upstreamModelId`, and builds correct scoped row selectors.
- `evals/proofs/live-provider-sync.proof.test.ts:70-75` uses `user.see("composer", {editable:true})` then `user.click("Change model")`.
- `evals/packages/behaviors/src/composer.ts:103-177` prefers supported `composer.set_text`, verifies the actual visible Lexical draft, and falls back to paste. **Do not assign editor.innerHTML/textContent.**
- `sendComposerMessage` (`179-212`) clicks the real Run task button, witnesses fresh user IDs, and doesn't substitute a raw prompt API call. Assistant DOM counts alone can be misleading because history is windowed.
- `composer.set_text` is focus-bound; inspect `window.__openworkControl.listActions()` before using it and do not assume a session ID argument retargets it (`session-surface.ts:2844-2863`). No `composer.steer` action is registered. Use the real keyboard path for steering, not an API shortcut.
- Model changes are disabled/closed while steering (`composer.tsx:293-297,1469-1484`); choose the model before the one paid turn.

## Minimal one-attendee proof for the lead (Daytona only)

1. Capture sanitized Den attendee model inventory + limit status. Stop if Sol alias is absent, readiness missing, or cap missing.
2. On the existing attendee desktop, create/open one task. Record route, focused Lexical composer and selected workspace. Take a before screenshot.
3. Open Change model; search Sol; select the exact alias from attendee inventory. Reopen to witness `data-checked=true`, then close and refocus composer. Screenshot selection.
4. Type one bounded real workshop task through the composer, send **once**, and record a new user-message ID/time. A raw engine POST does not prove this UI flow.
5. If steering is part of the agreed proof, while genuinely busy type one short refinement, press Ctrl+Enter once, witness the second user message and continued task; do not click Stop or wait for a nonexistent Steer label.
6. Follow real permissions/OAuth UI as needed; no broad permission/cache injection. Existing OAuth proof is separate from model proof (`evals/proofs/workshop-oauth.proof.test.ts` does no paid inference).
7. Require a **fresh completed assistant turn** with no error, actual requested runtime provider/model identity and output tokens, plus independent fictional-workplace readback of the requested effect. Capture after screenshot. Public catalog presence or selector success alone is not completion.
8. Only then decide whether the same setup can scale to 20. Preserve resource ownership and don't launch another world to diagnose this pilot.

## Checks performed / limitations

- Checked only this worktree; no infrastructure, provider mutation, credential retrieval, app launch, production/Render action, or push.
- Public trusted-catalog fetch: HTTP 200; Sol discovered as above. Checked-in gateway catalog static read: Sol present.
- `bun test worlds/lib/workshop.test.ts`: blocked before tests (`No such built-in module: node:sqlite` in installed Bun 1.3.10).
- `node --test worlds/lib/workshop.test.ts`: blocked before tests (`ERR_MODULE_NOT_FOUND` for workspace package `@openwork/labs`; no dependency installation performed).
- Existing workshop model unit test (`worlds/lib/workshop.test.ts:178-198`) stubs HTTP responses; even a pass would not establish ordinary-member visibility, supported live credentials, UI selection, or inference success.
- Root cause of the lead's live hidden-model symptom remains **unconfirmed without the sanitized attendee inventory/runtime observations**. This report deliberately does not claim that enabling one flag fixes it.
