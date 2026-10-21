# Windows workshop pilot — validation record

Date: 2026-10-20, 21:15 PT. **Incomplete — Windows preview failed before GUI sign-in. No Windows workshop pass claimed.** This is a normal workshop rehearsal, not the Windows certificate/lockout exercise. No fake CA, TLS bypass, production backend, new prerelease, or source-built Windows app is involved.

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

## Actual Windows result and blockers

Exactly one VM was allocated. Quota preflight and immutable release resolution passed. Downloaded installer size and SHA-256 matched the GitHub release metadata; digest was `sha256:a0bb3a04a2ad616d874766dfb8d550037da2a140b29331a72e6cf9d2e76a082a`. Windows Authenticode returned status 0, **Signature verified**. The interactive installer task returned 0.

1. **Executable-name bug in maintained tooling:** `evals/packages/hosts/src/windows-release.ts` hardcodes `...\\@openworkdesktop\\OpenWork.exe` for every distribution. The actual official enterprise 0.18.59 installation contains **`OpenWork Enterprise.exe`**, not `OpenWork.exe`. Thus the installation probe waited despite a successful install. An own-VM hardlink alias to the exact installed executable, with identical SHA-256, let the existing launcher continue. No app bytes, TLS settings or release assets were modified. This is a diagnostic workaround, not a clean end-to-end pass or a durable code fix.
2. The maintained interactive launch task then produced an actual **session 1** OpenWork process and a `DevTools listening on ws://127.0.0.1:9223/...` log line. This proves process placement, **not** a working GUI, completed sign-in or model task.
3. Private noVNC initially passed HTTP content verification. CDP from the private preview returned 502, and subsequent exec-based CDP probes timed out. A diagnostic own-VM TCP relay attempt did not establish access before failure. No RFB/GUI screenshot was obtained.
4. The wrapper's stricter `waitForNoVnc` transport check failed with timeout. `world up` exited **1** after **7m 46s**, before saving a ready world snapshot. Its cleanup **automatically deleted the owned VM**, despite the inner CDP stage saying the viewer would be kept. An independent provider GET then returned **404**, confirming deletion. There is no surviving viewer to inspect or distribute.
5. No second VM was allocated: the authorization limited this rehearsal to one. No shared backend or Linux attendee was reset, stopped or extended. Repairing the executable selection and transport/retention behavior requires a new authorized rehearsal, not a claimed workshop pass.

A separate ordinary Windows member was created through supported Den invitation/signup/accept APIs. Its provider inventory was Ready and inherited the workshop hard allowance. The backend required an Origin header for authentication and rejected passwords longer than 32 characters; the final generated password was within that limit. This API preparation is **not GUI sign-in acceptance**. No workspace was created, no OAuth consent approved, and no paid model request sent by this Windows member.

## Acceptance and canonical exercise outcomes

**Blocked before actual GUI traversal.** All eleven remain **not submitted**: 0 queued, 0 running, 0 completed, 0 task executions failed. The infrastructure launch failed; it is not eleven agent-task failures. Required gates: private Den GUI sign-in as the new ordinary member; discover/select GPT-6.1 Sol; five same-profile consents; paid five-tool local/Drive write; busy Ctrl+Enter steering; own-attendee reset; same-task rerun without reconsent; then canonical tasks below.

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

Private diagnostic scripts, launcher logs, quota/resource facts and the final receipt remain outside git in the operator's `ww-windows-pilot` temporary directory. There is **no live signed viewer**: startup failed before ready outputs and the VM is deleted. Screenshot evidence is explicitly blocked by the failed CDP/RFB transport and automatic cleanup; process/API facts do not substitute for it. Never publish those URLs or browser/member credentials. No upstream model key enters Windows. The initial ordinary-member inventory reports Workshop OpenAI Ready and an inherited hard daily allowance; historical billing coverage is unknown, not a complete invoice.

The authorization cap was one Windows VM and $5 incremental infrastructure plus model spend. Windows-member model spend is **$0: no inference request was submitted**. The infrastructure invoice is unavailable; observed VM allocation-to-cleanup was under ten minutes (at most 0.334 vCPU-hours, 1.334 GiB-memory-hours and 8.334 GiB-disk-hours), not an overnight run. Do not present a container-rate estimate as a Windows invoice. The own-VM provider deletion guard was independently verified at **22:17:33 PT**, earlier than the shared backend deadline; actual automatic deletion occurred much earlier, and GET 404 was verified at 21:15 PT. Nothing remains running from this Windows attempt. Cleanup was limited to the exact owned VM; the shared backend was untouched.
