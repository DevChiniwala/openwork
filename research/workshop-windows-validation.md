# Windows workshop pilot — validation record

Date: 2026-10-20. **Incomplete — Windows browser Den sign-in passed after the authorized replacement; desktop transport, paid-task/reset acceptance and all canonical exercises remain blocked. No Windows workshop pass claimed.** This is a normal workshop rehearsal, not the Windows certificate/lockout exercise. No fake CA, TLS bypass, production backend, new prerelease, or source-built Windows app is involved.

## Scope and reproducible launch

Use one new private Daytona `windows-medium` VM (2 vCPU, 8 GiB RAM, 50 GiB disk), a distinct ordinary fictional member and fresh Windows browser profile, and the existing isolated workshop backend. Do not copy an authenticated Linux profile or alter another attendee's data. The backend and its stable signed Den/workplace origins are an existing owner-controlled dependency; do not regenerate them.

The driver checkout is `690b4b4d22d25e53de11db83aa2291623ff96740`; the Linux functional-pilot source is separately `7d381c9d0f42c37a5537ede6019b7225c1ffc7d0`. The Windows bytes are the published **0.18.59 enterprise x64 installer**, whose Git tag resolves directly to commit `0c60c8a6dd22db83a6c68552c00cabe601ec1f77`, not either source checkout. This tag resolution is provenance metadata, not a locally reproduced build. Remote `origin/dev` is only the tooling reference reported by the preview wrapper; it is not a claim about the release's binary source.

```sh
# Install the separate evals workspace too; the root install alone omits mysql2.
pnpm install --frozen-lockfile
(cd evals && pnpm install --frozen-lockfile)
pnpm world help preview-desktop --json
# plan does NOT accept --source or --seed in this driver.
pnpm world plan preview-desktop --place daytona --os windows --stage <unique-stage>
# Scope DAYTONA_API_URL and the team DAYTONA_API_KEY to this command only.
pnpm world up preview-desktop --place daytona --os windows \
  --stage <unique-stage> --source desktop=release:0.18.59/enterprise \
  --seed blank --detach --timeout 600000 -- --lifetime 45
pnpm world outputs preview-desktop --stage <unique-stage> --reveal --json
```

Before allocation, discover the actual organization from the authorized backend's sandbox record and GET `/organizations/<actual-org>/usage`. Use the `us` / `windows` pool, not container quota. This run observed 0/20 CPU, 0/80 GiB memory, 0/300 GiB disk in use. The `/sandbox/<id>/organization` route returned 403; the authorized GET `/sandbox/<id>` already supplied `organizationId` without any permission change.

The maintained launcher resolves the immutable release asset, checks API-published byte count and SHA-256 inside Windows, installs and launches with interactive Administrator scheduled tasks, and probes private noVNC/CDP. `daytona exec` is SYSTEM/session 0 and must not be used to claim an interactive app pass. It may prepare files and inspect explicitly named interactive-user paths. The launcher adds a 30-minute provider-TTL startup reserve, so impose an additional fixed event deadline immediately after allocation. Never extend the shared backend.

## Linux result and what made it work

The independently documented Linux pilot passed the five-app functional path, **not** the entire narrative workshop or fleet. See [the live Linux report](workshop-pilot-validation.md).

- Isolated dev-mode Den, Gateway and SQLite-backed workplace were in one owned backend, with the same signed issuer origin used for discovery and callbacks. A production/shared service was not used.
- Real ordinary-member OAuth approvals for Outlook, Calendar, Drive, Jira and Confluence all used the same real browser profile; the model saw actual provisioned runtime aliases rather than an invented provider name.
- GPT-6.1 Sol read all five services, saved a local markdown file and wrote/read back a Drive marker. Ctrl+Enter while busy produced an actual second user message and changed the saved file.
- Reset confirmation alone preserved the marker; the attendee's actual reset restored both data hashes exactly, retained identity and grants, and allowed the same paid task to finish again without reconnecting.
- Native user-gesture clicks were needed to open OAuth popups. Completed callback tabs can close their CDP connection; inspect Ready state rather than blindly reconsenting. Multiline composer prompts may become expandable Pasted text nodes; verify the full draft before submission.
- Published-release Windows verification and Linux source verification are distinct. A Linux pass does not certify Windows first-launch sign-in, Windows shell operations, or canonical task outcomes.

## First attempt — before launcher repair

Exactly one VM was allocated in the first attempt. Quota preflight and immutable release resolution passed. Downloaded installer size and SHA-256 matched the GitHub release metadata; digest was `sha256:a0bb3a04a2ad616d874766dfb8d550037da2a140b29331a72e6cf9d2e76a082a`. Windows Authenticode returned status 0, **Signature verified**. The interactive installer task returned 0.

1. **Executable-name bug in maintained tooling:** `evals/packages/hosts/src/windows-release.ts` hardcodes `...\\@openworkdesktop\\OpenWork.exe` for every distribution. The actual official enterprise 0.18.59 installation contains **`OpenWork Enterprise.exe`**, not `OpenWork.exe`. Thus the installation probe waited despite a successful install. An own-VM hardlink alias to the exact installed executable, with identical SHA-256, let the existing launcher continue. No app bytes, TLS settings or release assets were modified. This is a diagnostic workaround, not a clean end-to-end pass or a durable code fix.
2. The maintained interactive launch task then produced an actual **session 1** OpenWork process and a `DevTools listening on ws://127.0.0.1:9223/...` log line. This proves process placement, **not** a working GUI, completed sign-in or model task.
3. Private noVNC initially passed HTTP content verification. CDP from the private preview returned 502, and subsequent exec-based CDP probes timed out. A diagnostic own-VM TCP relay attempt did not establish access before failure. No RFB/GUI screenshot was obtained.
4. The wrapper's stricter `waitForNoVnc` transport check failed with timeout. `world up` exited **1** after **7m 46s**, before saving a ready world snapshot. Its cleanup **automatically deleted the owned VM**, despite the inner CDP stage saying the viewer would be kept. An independent provider GET then returned **404**, confirming deletion. There is no surviving viewer to inspect or distribute.
5. No second VM was allocated: the authorization limited this rehearsal to one. No shared backend or Linux attendee was reset, stopped or extended. Repairing the executable selection and transport/retention behavior requires a new authorized rehearsal, not a claimed workshop pass.

A separate ordinary Windows member was created through supported Den invitation/signup/accept APIs. Its provider inventory was Ready and inherited the workshop hard allowance. The backend required an Origin header for authentication and rejected passwords longer than 32 characters; the final generated password was within that limit. This API preparation is **not GUI sign-in acceptance**. No workspace was created, no OAuth consent approved, and no paid model request sent by this Windows member.

## Authorized replacement — repaired source and measured result

The parent authorized **one replacement only**, retaining the original cumulative $5 budget and existing backend deadline. No third allocation occurred; no more than one Windows VM was alive at once.

### Maintained repairs and tests

Pushed source `e69715eb9f` fixes the maintained Windows release launcher, rather than installing executable aliases:

- Distribution-aware installed binary selection: `OpenWork.exe`, `OpenWork Cloud.exe`, `OpenWork Enterprise.exe`, in the actual installer directory. Public/Cloud/Enterprise cases have tests; Cloud and Enterprise filenames were also observed on the VM.
- Authoritative digest/size **and Windows Authenticode Valid** verification before interactive installation.
- The release app explicitly enforces CDP on **127.0.0.1:9223**. Direct private Daytona port 9223 therefore cannot reach its loopback listener. The launcher now configures a separate **private VM-only relay on 19825 → 127.0.0.1:9223**, after a local CDP response. This relay path has mocked command/contract tests; the failed initial runtime never reached that setup step. A later diagnostic configured the relay on the owned VM before the Cloud launch; that still did not cure guest-wide transport loss.
- Opt-in `OPENWORK_DAYTONA_RETAIN_FAILED=1` now requires an explicit `OPENWORK_WINDOWS_PREVIEW_DEADLINE` 1–90 minutes ahead. The provider TTL is capped, not extended by the normal startup reserve. Provisioning failure and outer viewer/RFB failure both retain the diagnostic VM without claiming a ready viewer. Successful outer readiness explicitly calls `markReady()` and normal teardown still deletes the successful preview.
- **9/9 launcher unit tests pass**, including three distributions, bounded-deadline rejection, failure cleanup versus retention, outer-disposal retention, acknowledged-ready cleanup, version identity and relay/signature commands. These tests are not a GUI workshop verdict.

```sh
# Controller environment only; team Daytona credential is scoped as above.
OPENWORK_DAYTONA_RETAIN_FAILED=1 \
OPENWORK_WINDOWS_PREVIEW_DEADLINE=<absolute-ISO-deadline-within-90-minutes> \
OPENWORK_EVAL_REF=<full-pushed-repaired-tooling-sha> \
pnpm world up preview-desktop --place daytona --os windows \
  --stage <unique-retry-stage> --source desktop=release:0.18.59/enterprise \
  --seed blank --detach --timeout 600000 -- --lifetime 45

# Tests run before replacement allocation:
(cd evals && pnpm exec vitest run --project pr packages/hosts/src/windows-release.test.ts)
```

### Actual replacement traversal

1. Rechecked actual organization Windows quota: 0/20 CPU, 0/80 GiB memory, 0/300 GiB disk. Created one new private `windows-medium`; verified its provider deletion guard before proceeding. The shared backend was not extended.
2. Official Enterprise 0.18.59 digest/signature passed; installer finished with task result 0. The fixed launcher found **the actual Enterprise executable** and witnessed session 1, with **no alias/hardlink**. Private viewer HTTP initially passed. Local CDP probes later timed out, followed by the outer noVNC/RFB failure; world exit was 1 after 5m 31s. **Retention worked live:** the VM was not deleted.
3. Diagnostics distinguished a loopback/proxy issue from a larger failure: provider still reported started/private, but private viewer HTTP, RFB, CDP and even direct toolbox `cmd /c whoami` timed out. A **single stop/start of this same VM** restored `whoami` (SYSTEM), private noVNC HTTP **200**, and an actual **RFB 003.008** banner. With the app stopped, private 9223/19825 returned **502**, as expected without an app listener. This was not another allocation. The guard was verified again after the restart.
4. Launched the installed Edge browser as interactive Administrator with a fresh `C:\\ow\\browser-profile`, a private browser-CDP relay, and `--disable-gpu`. Real GUI email → Next → password → Sign in reached the private Den dashboard as the distinct **ordinary member**. The screenshot shows the Member role and workshop organization. No Linux cookies/session were copied.
5. The member's actual authenticated install configuration advertised **distribution `cloud`**, requireSignin true, and no Enterprise activation. Rather than fabricate activation or change Den flags, installed the backend-compatible official **Cloud 0.18.59 x64** on the **same VM**. Its 374,988,256-byte installer matched `sha256:eba484defa9a8586bbddf694d5e9bd5ae3489a2ac9b4ec4834dfdfb14fed1880`, Authenticode Valid, interactive installer result 0, and actual `OpenWork Cloud.exe` filename. This is a separate release distribution, not an Enterprise desktop pass.
6. The same Windows browser reached Your Connections and the real Outlook consent for a fresh fictional workplace guest. A screenshot records the consent, scope/resource details and no password field. One Allow mouse dispatch was attempted, but the connected callback was **not confirmed**; do not call it a successful grant or blindly reconsent. No other grant or five-Ready state was confirmed.
7. Launching the Cloud app in session 1 with `--disable-gpu` again coincided with private CDP timeout and `whoami` timeout. Later the toolbox **file-download** endpoint recovered and returned the actual Cloud desktop log. It records **`Managed OpenCode process did not exit after SIGKILL`**, through `server/dist/managed-opencode.js:50`, managed server startup, embedded server startup, and `openworkServerRestart`. This is a concrete shipping-runtime failure, not a model/provider rejection. CDP HTTP eventually listed the actual packaged app page through the private 19825 relay, but renderer evaluation timed out and the page WebSocket could not connect within 20 seconds. An additional bounded real-RFB framebuffer capture attempt also failed transport, so no desktop screenshot is claimed. Intermittent guest-wide transport loss has not been fully root-caused; a working HTTP target list alone does not prove a usable app. Browser/consent partial evidence does not prove desktop acceptance. No paid task, steering, reset, rerun or canonical task was submitted. No second VM restart or third allocation was attempted.

Screenshots and raw diagnostics remain private. No claim is made that the published release's GUI task loop, model picker or Windows filesystem tools passed.

## Acceptance and canonical exercise outcomes

**Windows-browser Den GUI sign-in passed; desktop acceptance remains blocked.** All eleven remain **not submitted**: 0 queued, 0 running, 0 completed, 0 task executions failed. The infrastructure launch failed; it is not eleven agent-task failures. Required gates: private Den GUI sign-in as the new ordinary member; discover/select GPT-6.1 Sol; five same-profile consents; paid five-tool local/Drive write; busy Ctrl+Enter steering; own-attendee reset; same-task rerun without reconsent; then canonical tasks below.

| Exercise | Windows status |
| --- | --- |
| T10 — morning brief | Not submitted |
| T01 — one-pager | Not submitted |
| T02 — reusable work | Not submitted |
| T03 — colleague execution | Not submitted |
| T04 — account review | Not submitted |
| T05 — review deck | Not submitted |
| T06 — follow-up ticket | Not submitted |
| T09 — honest not-found | Not submitted |
| T08 — feedback | Not submitted |
| T11 — follow-up meeting | Not submitted |
| T12 — guidance update | Not submitted |

T07 Windows lockout is explicitly excluded. Canonical prompts come from the private presenter guide recorded in the Linux receipt, never from this table's shorthand. Queued, running, completed and failed must remain separate statuses. Do not deliver real external messages, invitations or feedback, schedule production jobs, impersonate another member, or invent fixture support.

## Access, budget and cleanup

Private scripts, launcher logs, quota/resource facts, receipts, signed viewer and two actual Windows-browser screenshots remain outside git in the operator's `ww-windows-pilot` temporary directory. The original VM was independently confirmed deleted via GET 404. The replacement is **retained for diagnostics**, not a ready viewer or ready world: its current guest transport is blocked. Its signed viewer is saved privately, but should not be described as functioning. No upstream model key entered Windows, and controller credentials were never written into the repository or guest. The ordinary-member API inventory reported Workshop OpenAI Ready and its actual aliases; that is not actual desktop model selection.

The original authorization plus explicit one-replacement authorization keep cumulative incremental infrastructure plus model spend capped at **$5**. Windows-member model spend is **$0: no inference request was submitted**. Daytona's published pricing lists CPU $0.0504/vCPU-hour, memory $0.0162/GiB-hour, disk $0.000108/GiB-hour and Windows $0.0858/vCPU-hour. Conservatively treating Windows as an additional surcharge gives **$0.4074/hour** for 2 CPU / 8 GiB / 50 GiB. Bounding both attempts through the replacement's hard guard is **under $0.60** infrastructure, excluding credits; this is a ceiling estimate, not an invoice. See [Daytona pricing](https://www.daytona.io/pricing).

The replacement's provider auto-destroy was independently verified after its same-VM restart at **22:18:24 PT**, before the required 22:20 PT ceiling and shared backend expiry. No expensive exercise work may continue past **22:15 PT**. No third allocation or backend TTL extension is authorized. Keep the failed VM only for bounded diagnosis until that guard; delete only this exact owned VM if abandoning it sooner. The shared backend and Linux attendee data/tasks remain untouched.
