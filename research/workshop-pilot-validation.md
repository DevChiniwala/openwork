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

The two engine cost estimates total approximately **$0.347**. These are estimates, not a provider invoice. Gateway settlement separately recorded real paid usage and an organization-assigned, per-member $5/day hard policy. Historical coverage reports itself unknown; that is not evidence of complete historical billing.

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

**Queued does not mean completed.** The initial T10 task already identified missing news source material/feed capability and accurately labeled its result incomplete, with a simulated—not production—schedule. Later exercises may require a real second member, native Workflow sharing, a feedback stand-in or additional fixture support. Their results must be reviewed separately; the five-app pilot is not a claim that every narrative beat works.

## Failures, repairs and tests

- First allocation: Den API and Gateway started, but Den Web's production build included colocated React test files and failed their type compatibility check. The original helper automatically deleted that failed backend; deletion was independently confirmed before another allocation.
- Repair: production tsconfig now excludes `*.test.ts(x)` while preserving production type checking. Diagnostic runs can explicitly retain failed infrastructure via `OPENWORK_DAYTONA_RETAIN_FAILED=1`; the operator must record IDs, provider TTL and teardown responsibility immediately.
- Native browser clicks were necessary for popup authorization; synthetic `.click()` without a user gesture did not create the popup. No consent was repeated blindly.
- A completed callback tab's close rejected its CDP send; subsequent work attached to the existing Ready state, without reconsenting. Background-tab screenshot capture required bringing the target forward.
- Multiline canonical prompts collapse into the composer's Pasted text node. The operator expanded and verified the actual full prompt before sending; the first timed-out draft check had sent nothing.
- Local source checks: **28/28** workshop, OAuth-helper and template-gate tests pass; Den Web type check passes; workshop module import and server-script shell syntax pass. The pure/helper tests do not substitute for the live path above.

## Remaining fleet gate

Do not capture or clone this authenticated pilot. Prefer the existing maintained clean software base plus deterministic, pre-launch Den binding unless a separately audited signed-out software-only template can be proved. A UI signed-out label is insufficient. The template must contain no member/browser identity, cookies, grants, credentials, attendee files, backend data or viewer tokens.

Before any 19-seat replication: verify exact template provenance and source, a fresh normal sign-in from that template, per-clone empty/fresh profiles and Den connectivity, current US-container quota/cost/TTL, private signed viewer/terminal/debug access, and actual exercise capabilities. Do not rebuild shared snapshots, create per-seat snapshots/volumes, clean up unrelated resources, or infer acceptance from desktop startup alone.
