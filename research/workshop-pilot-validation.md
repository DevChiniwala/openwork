# One-attendee workshop pilot — live Daytona result

Verified 2026-10-20. **Functional pilot PASS; fleet and full canonical workshop are NOT yet approved.** This report contains no access links, tokens, passwords, environment IDs, or customer data. The operator's private receipt and screenshots remain outside git.

## Exact scope and source

- One owned Daytona **container** backend: isolated development Den API/web, MySQL, AI Gateway and the fictional Open Workplace gateway. No Render dependency.
- One owned ordinary-attendee desktop, built from the maintained software base and the exact pushed source `7d381c9d0f42c37a5537ede6019b7225c1ffc7d0`.
- The backend and desktop each independently reported that full source SHA.
- Never more than two live pilot containers. No fleet, custom snapshot, shared snapshot change, shared volume change, or other operator's environment was used.
- The desktop fixture initially established the ordinary-member app session. Separately, the attendee actually signed in through the real Den browser email/password UI. This is not a claim that desktop first-launch sign-in or a future signed-out template has been traversed.

## Traversed path

1. Den API/web and AI Gateway healthy. The workplace used SQLite-backed isolated guest data.
2. A fresh browser joined automatically, read its own data, reset and left. Plain OAuth discovery from **inside Den**, not merely a bypass-header runner probe, passed for Outlook, Calendar, Drive, Jira and Confluence. The runner passed the same plain and warning-bypass checks. The saved signed hostname remained the exact issuer/resource origin.
3. The ordinary attendee's usable provider inventory returned Workshop OpenAI, source `openwork_gateway`, credential status `ready`, upstream `gpt-6.1-sol` and its real `ipr_…` / `gwm_…` runtime identities. No organization feature flags were changed. The actual runtime was legacy (native v2 and liveProviderSync off), and it worked.
4. The attendee selected **GPT-6.1 Sol** through the actual composer popover. The old model-picker assumptions were not used.
5. The real member Connections UI opened and approved five provider consents. Each consent showed the same fictional guest, no password field, `workplace` scope and the exact corresponding resource. All five returned connected callbacks and Ready status. All consents used one real browser profile.
6. The attendee sent a real paid task through the desktop composer. It read an Outlook message, Calendar event, Drive document, Jira issue and Confluence page; wrote `workshop-pilot-summary.md` in its local workspace; and created/read back a small Drive marker file.
7. While the task was actually busy, the attendee typed a refinement and pressed **Ctrl+Enter** on Linux. A second user message appeared. The task continued and the local file ended with the requested `Pilot steering received.` line. No Stop-button substitution or raw prompt API was used.
8. The first run completed normally with 2,519 output tokens, the expected provisioned provider/model alias, no assistant error, and completed tool calls. Independent filesystem and workplace readback verified the artifacts.
9. Opening reset confirmation did not remove the marker. Clicking the actual reset button returned both the Microsoft and Atlassian state hashes **exactly** to baseline, preserved the same guest, and removed the marker. The five member connections remained Ready with zero Sign in controls; no reconsent occurred.
10. The attendee started a fresh session and sent the exact same original task through the composer. It again used all five connections, wrote the local file, recreated/read back the Drive marker, and completed normally with 1,360 output tokens and no assistant error.

The two engine cost estimates total approximately **$0.347**. These are estimates, not a provider invoice. Gateway settlement separately recorded real paid usage and an organization-assigned, per-member $5/day hard policy. Historical coverage reports itself unknown; that is not evidence of complete historical billing. Final observed settled usage was **$2.618612 for the pilot** (including canonical tasks/retries) and **$0.155326 for the canary**, **$2.773938 combined**, with zero pending requests. This excludes the independently owned Windows lane and other owners. No further model runs were scheduled. The policy is daily, resets at 05:00 UTC, and is **not** an event-total spending cap.

## Access and secret boundary

The existing provisioning defaults originally created public containers. **After functional verification**, the operator changed only the two owned containers to private and verified:

- provider API reports `public:false` for both;
- the existing signed Den and workplace origins still work without a provider API credential;
- the unsigned desktop viewer returns **HTTP 401**;
- a newly generated, explicitly 120-minute signed viewer passes both HTTP and RFB/WebSocket transport.

The original world-output viewer used the provider's default lifetime. Do not distribute that old link for a longer event. The source now requests private workshop containers and explicitly signs viewers through the world lifetime plus reserve, rejecting unexpected path/query-auth shapes instead of discarding authentication. These startup changes pass source tests/import/shell syntax checks; they are **not** represented as a fresh full boot of a different SHA.

A read-only scan of 62 desktop process environments found no upstream-model or controller API key names, and no shared `/daytona-secrets` mount. The provider key was provisioned only into the backend's encrypted provider storage. This does not imply an authenticated desktop is safe to snapshot: it intentionally contains its member session and OAuth-backed runtime access.

## Canonical exercise queue — separate from pilot acceptance

After the functional pass, the operator read the private presenter's actual copyable prompts, not an invented exercise list. Eleven canonical prompts were submitted in one new desktop conversation:

`T10 → T01 → T02 → T03 → T04 → T05 → T06 → T09 → T08 → T11 → T12`.

T07 (Windows lockout) was excluded as requested. The first task was started through Run task and the following ten were queued by plain Enter **while busy**. An actual screenshot shows **10 queued**. Safety boundaries prohibit real email/invitation/feedback delivery, production scheduling, impersonation and invented success.

**Final Linux queue result:** every original prompt and two scoped follow-ups finished; **zero queued and zero running**. Eight exercises passed their stated fictional-service outcome; three remain incomplete/blocked. A clean assistant stop is not itself an exercise pass.

| Exercise | Final status | Measured result / limitation |
| --- | --- | --- |
| T10 morning digest | **Incomplete** | Saved/read back a revised digest and an unsent draft. Public research verified France, US and Japan timestamps in the requested Los Angeles day. Germany's accessible company release has the correct printed date but unverified time zone/time; the Reuters article returned 401. Output remains explicitly INCOMPLETE; schedule remains SIMULATED, no Automation. |
| T01 sourced comparison | **Passed** | Read the latest Blue Harbor thread and both full datasheets; saved cited comparison and an unsent threaded reply. Atlas 2: 300 kg / 2.0 m/s / 10 h; Atlas Lift: 1,200 kg / 1.5 m/s / 8 h. Site requirements remain unconfirmed, not invented. |
| T02 reusable Workflow | **Passed** | Native Workflow saved with one `customerRequest` input; authoring test and persisted cold-storage rerun assessed both products. One intermediate script call errored and was corrected; the saved rerun completed. |
| T03 recipient sharing/run | **Blocked** | Nora's workplace address is not an authenticated member of this workshop org. No viewer grant and no fake “as Nora” run. Requires a genuine recipient membership and recipient-authenticated run receipt. |
| T04 account analysis | **Passed** | Saved/read back analysis, with ARR, historical orders, relationship, growth, churn and citations kept distinct. |
| T05 PowerPoint | **Passed for file/content; visual review pending** | Actual seven-slide PPTX. Independent ZIP/XML check: seven substantive slides; Drive bytes and local bytes share SHA-256 `c41291da45312392d46d48f5db83db782a7294c31cb905c3c0da615b59735b6d`. No Office/PowerPoint visual-rendering claim. |
| T06 Jira follow-up | **Passed** | Created/read back the DOC task, Task type, correct title and Nora resolved through assignable-user lookup. |
| T09 missing-policy answer | **Passed** | Read full Handbook and office guidance; correctly found no dog policy, cited sources and suggested People Ops questions without web invention. |
| T08 feedback form | **Blocked** | No pilot-local feedback form/provider. The available action opens an external surface, so no real feedback was submitted and no confirmation was invented. |
| T11 calendar create/reschedule | **Passed after fixture-scope clarification** | The initial guard was too strict. Source confirms fixture creation has no outbound invitation transport. Created, moved and read back the same event ID; independent browser read found exactly one event at Oct 20, 11:00–11:45 America/Los_Angeles, with both fictional attendees, location and note preserved. No external invitation delivery. |
| T12 office update + threaded reply | **Passed** | Preserved office content, updated v5→v6, added/read back the requested comment and a same-thread Outlook reply with `isDraft:true`. Nothing sent. |

T07 Windows lockout is excluded. These results apply to Linux's ordinary-member conversation. The independently owned Windows lane must report its own results; none are inferred here.

## Failures, repairs and tests

- First allocation: Den API and Gateway started, but Den Web's production build included colocated React test files and failed their type compatibility check. The original helper automatically deleted that failed backend; deletion was independently confirmed before another allocation.
- Repair: production tsconfig now excludes `*.test.ts(x)` while preserving production type checking. Diagnostic runs can explicitly retain failed infrastructure via `OPENWORK_DAYTONA_RETAIN_FAILED=1`; the operator must record IDs, provider TTL and teardown responsibility immediately.
- Native browser clicks were necessary for popup authorization; synthetic `.click()` without a user gesture did not create the popup. No consent was repeated blindly.
- A completed callback tab's close rejected its CDP send; subsequent work attached to the existing Ready state, without reconsenting. Background-tab screenshot capture required bringing the target forward.
- Multiline canonical prompts collapse into the composer's Pasted text node. The operator expanded and verified the actual full prompt before sending; the first timed-out draft check had sent nothing.
- Local source checks: **28/28** workshop, OAuth-helper and template-gate tests pass; Den Web type check passes; workshop module import and server-script shell syntax pass. The pure/helper tests do not substitute for the live path above.

## Clean software template and fresh canary

The maintained base's raw pre-launch audit stopped on a nonempty root `.env.dev`. A content-free comparison established that it exactly matched public tracked source, not private attendee credentials. It still violated the no-env template contract. **No authenticated pilot was scrubbed or captured.**

The operator converted only that new, never-authenticated, audit-stopped machine into an owned temporary software builder. It installed the pinned software, removed the root dev environment and transient browser/profile state, audited the result with root privileges, stopped the builder, and requested a **cold filesystem snapshot with `includeMemory:false`**. The owned snapshot became Active; the builder was deleted, with HTTP 404 independently confirmed before canary allocation. Snapshot ID and audit receipts are private. One new software snapshot was created; no maintained/shared snapshot or volume was modified.

The fresh canary from that exact snapshot passed:

- raw pre-launch audit: no measured credential/personal paths, app/browser/backend process or shared secrets mount;
- exact pushed runtime SHA, unique new profile and no Den auth token/session origin before sign-in;
- private container and unsigned viewer 401; authorized HTTP plus RFB/WebSocket;
- **inside-canary** Den API JSON (`service:den-api`), DB readiness (`checks.database:ok`), actual OpenWork web HTML, and workplace health;
- a different newly enrolled ordinary member, actual browser email/password sign-in, then the visible supported **Paste sign-in code → Finish sign-in** desktop fallback;
- all five real OAuth consents in one new browser profile, with a different fictional guest;
- a real paid Sol task reading all five connections, writing/readback of a local verification file, 2,092 output tokens, expected provider/model alias, no assistant errors and normal completion;
- pilot marker absent by search, and **HTTP 404 by the pilot file's exact ID**, while the pilot's own browser still found that marker.

**Product/driver limitation:** automatic external-browser opening/return did not complete in this development desktop. The normal manual link/code UI worked. This is not a claim of one-click/deep-link sign-in success. No preexisting session or cookies were injected into the desktop, and no credential/code was saved to logs, receipts or the captured template. One-time code transfer stayed in memory and went through the actual visible UI field and Finish sign-in control; the app then stored its own newly established session normally.

The workspace was created through the app's existing registered `workspace.create` control, not a raw server/database mutation. Its initial route was the session-root composer; the first actual send produced the concrete session-ID route. This run does **not** certify the stricter immediate-session-ID/focus-after-create UI contract.

## Fleet gate result — no fanout

The canary passed, but the explicit 18-seat fanout request was rejected **before any allocation**: `Not enough fixed-event lifetime; renewal must be explicit`.

Current attendee total is **two**: the preserved original pilot and one fresh canary. The other 18 seats were not created. The runner counts those existing two toward 20; it does not allocate an accidental twenty-first attendee. There is no 20-seat readiness claim.

US-container quota was read using `/organizations/<actual-org-id>/usage`, including other owners' usage; API-key organization detail/list limitations are not a reason to guess capacity. The pool still had headroom, and the controller bounded incremental 19-seat compute plus a canary $5 model cap and builder reserve below $15. **Time, not quota, blocked this event.** Existing Den/pilot lifetimes and the user's pilot viewer were not extended. The shared world's application lifetime is around 22:25 PT; provider destruction is around 22:28 PT. New canary expiry is earlier. Owned replica/template cleanup is scheduled at the existing 22:24 PT controller deadline, not via a fresh 24-hour fleet.

An explicit renewed event/start-time plan is required before attempting the remaining seats. Do not weaken the gate, silently extend TTL, disable unrelated CI, delete other owners' resources, or infer workshop completeness from a running desktop.

## Reproducible operator HOW

1. Work only on the owned workshop branch/worktree. Push the reviewed software first, resolve a **full pushed SHA**, and set `OPENWORK_EVAL_REF` explicitly. Do not let remote default branches drift. The live software/image/canary in this report all used `7d381c9d0f42c37a5537ede6019b7225c1ffc7d0`. The final operator implementation checkpoint is `ea7222200725983dac6167cc7c9e3a3ac283b83c`; the report-only commit is newer. The exact final pushed HEAD is recorded in the private receipt and handoff.
2. Fetch the scoped Daytona key into the controller environment through the `get-env-var` skill, paired with `DAYTONA_API_URL=https://app.daytona.io/api`. Never overwrite the saved CLI login or inject all Infisical secrets. Only the original backend model-provisioning process receives the upstream model key.
3. Plan then start only one attendee with `pnpm world up workshop --place daytona --stage <event> --detach -- --count 1 --lifetime <approved-minutes>`. Diagnostic retention uses `OPENWORK_DAYTONA_RETAIN_FAILED=1`. Record owned IDs and **provider-confirmed fixed destruction time immediately**, including failures. A start receipt is not an attendee proof.
4. Probe exact saved OAuth issuer/resource origins plain from Den and runner using `worlds/lib/workshop-pilot-oauth.mjs`. Never remint Den/workplace identities or strip query/path authentication. Approve all five through actual member UI in the same profile. Use the current model popover/real `ipr_…` and `gwm_…` inventory rather than old selectors or an upstream model ID.
5. Traverse the real desktop task, running-task Ctrl+Enter steering, independent artifacts, confirmation-only reset GET, actual reset POST button, identity/state restoration and paid rerun without reconnecting. Never use a raw prompt API call as a substitute for UI send. Once another lane joins, never do a global reset.
6. Use `worlds/lib/workshop-replicate.mjs <private-receipt.json> <fixed-event-deadline-ISO>` only after the functional pilot passed. It starts one canary and exposes a mode-0600 local Unix control socket; it does not auto-fanout. Its receipt remains outside git and excludes credentials/signed hosts. The controller gets a scoped Daytona key, **not** the upstream model key.
7. If the maintained raw base fails audit, stop. `worlds/lib/workshop-build-software.mjs <private-receipt.json>` can prepare only the receipt's explicitly owned, never-authenticated audit-stopped builder, not the pilot. It performs cold capture, active-state verification and owned builder deletion. `--resume-after-software` is only for a diagnosed completed software-preparation checkpoint, not a blind rebuild/retry.
8. Understand hook ordering: `onCreated` records ownership/privacy/TTL; **`onExecReady` audits before checkout**, avoiding provider creation races; `onPrepared` removes dev config before any browser/app startup. An env-free image has an intentionally deleted tracked `.env.dev`: restore only its reviewed public blob for the existing Git clean-source gate, then remove it again before launch. Do not relax Git's dirty-worktree protection or copy arbitrary host environment files.
9. Start each attendee cold, with a unique profile and `{baseUrl, apiBaseUrl, requireSignin:true}` bootstrap **before the first app process**. Never seed an auth token or `enterpriseActivated` stamp to prove normal sign-in. If automatic return fails, use the real browser's one-time code and the documented manual UI; do not call a test auth action or mutate storage.
10. Approve the canary only from measured ordinary-member identity, five UI consents, independent guest isolation and paid model/file proof. Then request fanout explicitly through the controller. It rechecks current US-container quota, a bounded spend estimate and fixed remaining lifetime; concurrency is two; remaining seats stay signed out. Stop at the first failed/ambiguous owned creation and repair that ID, not a new fleet.
11. `worlds/lib/workshop-owned-expiry.mjs <private-receipt.json>` schedules cleanup of only that receipt's new replicas and owned software snapshot. It does not touch the shared Den/pilot, maintained base or Windows lane. Native provider TTL remains the authoritative VM backstop; software-snapshot cleanup is an operator/controller request, not a provider-native snapshot TTL.
12. Validate source without infrastructure using `node --test worlds/lib/workshop.test.ts evals/proofs/workshop-pilot-oauth.test.mjs worlds/lib/workshop-template-check.test.ts`, plus `node --check` for operator `.mjs` files, `bash -n .devcontainer/test-server-on-daytona.sh`, and the Den Web type check. These checks do not replace the live evidence above.

### Diagnosed preparation issues, not hidden retries

The owned canary was preserved throughout a provider exec-readiness race and a Git clean-source rejection of the deliberately absent tracked dev env. Enrollment then exposed two input/transport mistakes: missing trusted Origin on direct Better Auth requests, and a generated password over the 32-character limit. Both were corrected before normal UI sign-in. The canary VM was **not recreated** for these repairs. Actual signup, per-member grants and app sign-in were used; no database auth injection or fake success was substituted.
