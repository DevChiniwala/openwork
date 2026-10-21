# Workshop desktop template → one real pilot → 19 more

**Status: design and pure tests only; no live readiness claim.** No sandbox, snapshot, account, connector, model or viewer was created, changed or deleted for this check. No secrets read. The live pilot belongs to its existing owner; do not touch that owner's checkout or the separate fleet thread's resources.

## Decision / non-negotiable security gate

Reuse **installed desktop software**, never an attendee's authenticated desktop state. A successful signed-in pilot is validation evidence, **not the snapshot source**. Keep one shared isolated Den + AI Gateway + Open Workplace backend separate from all 20 desktops; retain per-member OAuth grants and per-browser fictional workspace isolation there.

Preferred order:

1. Audit the software inventory/build recipe and backend, while the live-pilot owner completes their path.
2. Obtain a **clean-build, cold, signed-out software template**, containing no backend or personal state. Build it from an allowlisted context; do not copy an entire existing `/workspace` or home. Do not transform an authenticated VM into a template by deleting a few obvious files. A fresh app profile alone does not sanitize the rest of the image.
3. Start **one fresh attendee from that exact template**, bind the dynamic Den config before the first app/browser process, then traverse the full workshop. If the existing live pilot uses a different base/build/bootstrap, it proves the backend path only; the final template still needs its own single fresh acceptance. Coordinate ownership rather than duplicating sign-ins casually.
4. Freeze the accepted template ID, source SHA and deterministic bootstrap/inventory digest. Only after full pilot acceptance allocate the remaining **19**, bounded concurrency 1–2. Leave them signed out; verify software, app startup and Den reachability on **every** desktop without signing in each attendee.
5. Release links only when the final inventory is exactly 20, including that pilot, and every readiness/access gate passes. One failed desktop means incomplete fleet, not “20 ready.” Never retry an ambiguous creation without reconciling its owned resource ID.

If software-only provenance or scrub correctness is unprovable, **do not snapshot that machine**. Safest fallback: audited clean base plus deterministic bootstrap per desktop, all pinned to the same pushed SHA. It costs more boot time but avoids copying user state.

## What this checkout actually does

Inspected starting commit `7d381c9d0f42c37a5537ede6019b7225c1ffc7d0`. Read-only `git ls-remote origin refs/heads/dev` returned `df9ef2cc33e46b0f9006c51c3c8bf09720921ba5` on 2026-10-20. The assigned workshop branch contains task-specific changes; no pull/rebase or changes to existing files were performed under the NEW-files-only constraint. Integration owner must reconcile with current remote before provisioning. This is not a claim that task branch equals remote HEAD.

| Source / function | Behavior and consequence |
| --- | --- |
| `worlds/workshop.ts:119-203`, `boot` | Owns Den → workplace → preflight → model → desktops. Backend checks happen before allocation. `--count 0` is backend-only, but starting a second world would create another backend; do not invoke it against the already-owned live pilot. |
| `worlds/lib/workshop-plan.ts:125`, `allocateDesktops` | Awaits first `launch`, then fans out and retries later failures once. **Not a full workshop acceptance gate**: current launch returns after `app(...)` + viewer readiness, not model response/all five OAuth flows/reset. Do not mistake its pilot log for permission to replicate. |
| `worlds/workshop.ts:190-199` | Calls `app({ den, place, as: key, ... })` for every member. Current world signs in **all** attendees; it does not implement “sign in only one, leave 19 signed out.” No integration changed here. |
| `evals/packages/env/src/desktop-app.ts:211-281`, `app({ signIn: false, workspace: false })` | Existing fresh-launch primitive; accepts a Den bootstrap without signing in or creating a harness workspace. `enterpriseActivated: true` bypasses activation, so cannot count as fresh activation proof. |
| Same file `:283-365`, signed-in `app` | Creates workspace, invokes `signInDesktopAs`, then reselects workspace; not a template-building primitive. Avoid installed-production mirroring helpers (`liveSharedProductionApp` / `mirrorInstalledProductionRendererState`). |
| `evals/packages/hosts/src/provision.ts:695-778`, `provisionSandbox` | Defaults to `openwork-eval-vnc`, lists snapshots then `create --snapshot <id>`, prepares source and cleans known profile dirs. **This cleanup is not a security scrub.** Default create includes `--public` unless `private: true`; workshop call chain must not assume private access. |
| `evals/packages/hosts/src/daytona.ts:608-686`, `launchElectron` | Generates a profile root and writes bootstrap before launch. Dynamic Den binding is possible on a **cold** software snapshot using this seam. `appendBlankProfileEnv` (`:551-571`) shows all isolated storage overrides. |
| `worlds/lib/preview.ts:372-390`, `freestyleDesktopPlan` | Freestyle snapshot resumes an app already started at build; rejects launch-time app settings. **Do not substitute that hot desktop for a dynamic-Den template.** |
| `worlds/workshop.ts:96-105`, `attendeeViewer` | Gets port 6080 preview, replaces URL search params, probes noVNC. **Potential access constraint:** query-auth previews would lose their credentials. Confirm actual URL form; never strip signed query/path material to make a link prettier. |
| `worlds/lib/workshop-plan.ts:187-219`, `workshopOutputs` | Marks passwords/reset token/viewer links secret. Secret output formatting is **not** viewer access control. |

## Daytona snapshot support (documentation, not executed)

Public docs read 2026-10-20: <https://www.daytona.io/docs/en/snapshots.md>. Installed CLI/SDK and regional rollout must be checked by the provisioning owner; local shared provider does not expose a capture operation (`evals/packages/hosts/src/sandbox-daytona.ts:79-80`). Do not guess a CLI capture subcommand.

Documented interfaces:

- `await sandbox.createSnapshot('software-template-name')`: cold capture, **stopped** sandbox. API `POST /api/sandbox/{sandboxIdOrName}/snapshot`, body `{ "name": "…", "includeMemory": false }`.
- VM hot capture uses `includeMemory: true`, sandbox Started. **Forbidden for this plan**, even if convenient. Container snapshots are filesystem-only. Distinguish sandbox class explicitly, not by its name.
- `await daytona.create({ snapshot: 'software-template-name' })`, or CLI `daytona create --snapshot <snapshot>`: many new sandboxes can use the same software snapshot. Add private access, unique ownership labels/names, lifecycle limits and per-clone bootstrap in the actual provisioner; bare documentation example is not the safe full launch recipe.
- `await daytona.snapshot.get(name)` / `snapshot.list(page, limit)`; local CLI already uses `daytona snapshot list -f json`. Verify **Active** state, region, sandbox class, immutable ID, CPU, memory, storage. Inactive snapshots cannot launch. Snapshot-from-sandbox is distinct from creating a snapshot from an image.
- Linux VM image creation needs an image reference (not a direct Dockerfile build); a reproducible clean image is the safer fallback when capturing an existing sandbox cannot be audited.

No capture/create command is supplied as an executable fleet script here, deliberately: that would bypass ownership, costs and the live-pilot gate.

## Common preflight — must pass before template acceptance/fanout

- **Ownership:** new workshop-specific stage/resource manifest; denylist IDs from other threads. Existing live pilot/backend must be coordinated with their owner; no extra Den, no reused main-thread sandbox or shared attendee profile. Record who owns teardown, without executing it here.
- **Den:** exact common HTTPS web/API and AI Gateway endpoints, same reviewed source SHA, valid TLS with no bypass. API `/health` must return JSON `{ ok: true, service: "den-api" }`, not a 200 preview interstitial; `/ready` must report `checks.database: "ok"`. `/health` alone is process reachability, not DB readiness (`ee/apps/den-api/src/app.ts:234-277`). Test from runner, Den and every desktop where relevant. Browser runtime-config must resolve to the intended API rather than public default Den.
- **Expiry:** inspect actual signed-preview validity for Den web/API, AI Gateway, workplace and **every viewer**. All must last through event end plus ≥10 min reserve. The workshop's 24-hour preview assumption and 1380-minute max are in `workshop-plan.ts:14-18`; `daytona.ts:595-605` viewer URL uses default preview lifetime, not that explicit 24-hour setting. Do not infer viewer TTL from world lifetime. Avoid idle-stop during event; set an explicit owned cleanup deadline.
- **Model:** `provisionWorkshopModel` may return `skipped` if no key; skipped is **not ready**. Require ordinary member usable inventory with provider `credentialStatus: ready` and expected `gwm_` alias (`workshop.ts:166-186`), member allowance and healthy AI Gateway; then one real response on the pilot, with authorized spend handled only by pilot owner. Keep provider keys server-side, not in image/browser or bootstrap.
- **Five connectors:** exact `outlook`, `calendar`, `drive`, `jira`, `confluence`. Org-wide connection existence is not per-member consent. `createWorkshopConnections`/`verifyWorkshopConnections` (`worlds/lib/workshop-gateway.ts`) check backend inventory; full pilot must consent each, call tools through Den, and verify isolation/reset. Run existing **read-only** `preflight` in `worlds/lib/workshop-pilot-oauth.mjs:20` from runner and Den sandbox against the exact origin. Checks both plain and skip-warning paths, issuer, PKCE, 401 challenge and browser login redirect. It does not grant OAuth or prove consent.
- **Quota:** remaining active snapshot slots, sandbox slots, vCPU, memory and disk after **all** other worlds, pilot and Den/workplace/Gateway, plus a safety reserve. For 19 more at measured `(c,m,d)`, require at least `(19c,19m,19d)` remaining, plus any template-builder resources and snapshot storage. Snapshot resource defaults are not actual fleet capacity. Check per-desktop free disk/runtime memory too; no inference from provider-wide quota alone.
- **Viewers/debug ports:** prefer private Daytona sandboxes. Alternatively explicit unique expiring bearer-link protection verified end-to-end; bare public noVNC is unacceptable. Test unauthenticated/invalid access rejection without leaking valid links. Test authorized page **and WebSocket**. Treat signed hostnames as credentials. CDP, VNC, artifacts and terminals must not become public side doors. `private` receipt requires an actual denied-access test, not just a label.

## Software-only boundary / audit scope

Allow: OS/runtime packages, Electron/OpenWork built artifact and digest, Chromium binary, Xvfb/window manager/noVNC software, pinned Node/pnpm/dependencies, generic non-secret launcher, fictional **unassigned** fixtures if their provenance is reviewed. “Items running” means services start and are verified **after** cold clone boot; it does not require frozen running memory.

Absent at capture: Den auth/session tokens, email/passwords, active org/member IDs, browser cookies/localStorage/IndexedDB/service workers/session restore, Chrome profile identities and sync state, OAuth PKCE/state/code/grants, provider keys, CLI cloud credentials, SSH/private registry credentials, tokens/env stores, encryption/vault keys, attendee documents/downloads/history/clipboard/screenshots, logs containing credentials, viewer/VNC/CDP access credentials and signed URLs, reset tokens, backend SQLite/MySQL state, mounted secret volumes. Generate access credentials and fresh machine/profile identities **after clone**. Audit image layers/build context, all user homes, temporary/build files, logs and mounts; a UI signed-out label is not proof.

Concrete storage references:

- `apps/app/src/app/lib/den.ts:100-114`: `openwork.den.authToken`, `openwork.den.sessionOrigin`, `openwork.den.activeOrgId/Slug/Name`, base URL and MCP sync marker in renderer localStorage. Do not export their values.
- `apps/desktop/electron/blank-slate-profile.mjs:7-25,46-68`: Electron userData, HOME/XDG trees, `OPENWORK_ENV_STORE`, `OPENWORK_TOKEN_STORE`, runtime SQLite, OpenWork data, OpenCode config/database paths. The entire scope needs fresh storage; not only `Cookies`.
- `apps/desktop/electron/workspace-store.mjs:176` / `runtime.mjs`: `openwork-server-tokens.json`; `secure-vault-key.mjs` stores encryption material. Credential storage may be encrypted and still unsafe to clone.
- Source trees can contain `.env*` (including the current checkout's `.env.dev`), `.openwork-daytona`, provider auth files or git credentials. Do not inspect values or copy them into a template. Use a clean allowlist/build export rather than “copy repo then scrub.”

## Binding a changing Den endpoint safely

A cold software image with no app/browser running can bind dynamic endpoints deterministically: create clone-specific HOME/config/browser/userData trees; write only approved public deployment config to the per-clone bootstrap; resolve and validate exact web + API via the existing bootstrap/runtime-config contract; launch processes afterwards. `desktop-bootstrap.json` supports `baseUrl`/`apiBaseUrl`; do not assume `apiBaseUrl` is honored without checking the selected launch path. Existing `app()` seeds web base and optional enterprise activation and may discover API at runtime.

Do not bake an expiring signed Den hostname into the reusable software template. No bootstrap claim tokens or activation credentials in the snapshot. If actual enterprise activation is in scope, traverse it fresh on the one pilot rather than using `enterpriseActivated: true`. New profiles must retain the desired runtime binding on normal restart without falling back to production.

If available snapshot machinery resumes Electron before launch-time config, or cannot prove a new profile/config is read before auth/network activity, **it cannot safely meet dynamic Den binding**. Use clean base + deterministic cold bootstrap; do not patch a resumed authenticated profile or transplant localStorage. Current Freestyle guard documents exactly this constraint.

## Reusable verification helpers (new files only)

`worlds/lib/workshop-template-check.ts` exports:

- `checkTemplate(receipt)`: gates cold clean provenance, audit, active state, no residue/backend, pre-launch binding.
- `checkCapacity(available, perDesktop, remaining = 19, newSnapshots = 1)`: remaining headroom arithmetic; pass 0 snapshot slots needed if the audited active template is already counted, and include any builder separately.
- `checkPilot(pilot, template)`: one actual fresh UI sign-in/return, ordinary member, restart, model response, five connector consents/exercises, isolation/reset and focused composer. Requires matching final template/SHA.
- `checkFleet(input)`: final exact 20 owned sandbox IDs, distinct profile identities, common endpoints/build, 19 allocated **after** pilot acceptance, only pilot signed in, per-clone inventory/app/network/TLS/access evidence, freshness/expiry.
- `probeDenReachability(apiUrl, webUrl)`: explicit GET-only anonymous network probe, rejecting redirects/interstitials/wrong health service; never auto-runs on import. Execute **inside each existing clone** with current public endpoints supplied in memory. It checks server reachability only, not browser CORS, auth, readiness DB, workplace, preview expiry or access protection. It intentionally rejects query-bearing endpoints instead of stripping their credentials; obtain a supported exact origin or stop.

All receipt functions are **pure validators of measured evidence**, not scanners or live proof. Do not fill booleans from assumptions. No raw credentials/viewer URLs should be stored in receipts. Private evidence may contain signed Den hostnames; do not commit it. Error output uses ordinal desktop numbers and does not echo URLs/exception strings. Treat web HTML heuristic as a limited reachability check, not app authenticity or authenticated readiness.

Pure test command (no app launches/network/provider calls):

```sh
node --test worlds/lib/workshop-template-check.test.ts
```

Probe usage from an already-owned clone, after transferring the new standalone helper via its owner-approved mechanism (not run by this support task):

```js
import { probeDenReachability } from './worlds/lib/workshop-template-check.ts';
const checked = await probeDenReachability(process.env.WORKSHOP_DEN_API_URL, process.env.WORKSHOP_DEN_WEB_URL);
console.log(JSON.stringify(checked));
process.exitCode = checked.ok ? 0 : 1;
```

Read-only discovery command against an existing gateway, run by its owner from both runner and Den; do not put signed URLs in argv/history:

```sh
node worlds/lib/workshop-pilot-oauth.mjs
```

It reads `WORKSHOP_PILOT_URL` from the environment. Do **not** invoke browser helper `browserProbe('mark')` during read-only checks: it writes sample data. `browserProbe('snapshot'/'find')` are existing pilot evidence seams only; state/reset tests belong to the authorized live-pilot owner.

## One fresh attendee acceptance checklist (owner-executed)

1. Before any sign-in, record final template/SHA/inventory, distinct new profile identity, no auth/grants/cookies/workspace artifacts (presence/absence only), correct resolved Den and viewer protection.
2. Create/select local workspace and fresh task through real UI. Ready route `/workspace/<workspace>/session/<session>`; empty composer focused, role textbox, `contenteditable=true`, `data-lexical-editor=true`. No settings/empty session-root landing.
3. Sign in an ordinary new attendee through actual browser + desktop return/deep-link path; prove same intended org/member in Den and desktop without logging tokens. No admin reuse, no injected stored session. Restart app and check only that member's session retained.
4. Obtain one actual model reply from configured Gateway alias. Connect/consent all five workplace apps and perform the workshop's real exercises via Den, not direct unauthenticated fixtures.
5. Verify private workspace isolation against an independent **signed-out/anonymous browser fixture** or backend owner-controlled test principal, not a second signed-in attendee desktop. Verify reset affects only intended fictional state and grants stay valid; no other member's data visible. All five connector exercise success and reset semantics need evidence.
6. Preserve content-free facts, timestamp and private evidence references; explicitly approve acceptance. Never capture this signed-in VM as the template. Then and only then start the remaining 19 signed-out clones.

**Outstanding:** actual common endpoints/TLS/expiry, active snapshot/quota inventory, signed-out image audit, protected viewer behavior, template-bound full pilot and every-clone probes are intentionally unverified here. This support commit cannot authorize fanout or claim the pilot passed.
