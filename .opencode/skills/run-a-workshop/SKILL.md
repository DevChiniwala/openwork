---
name: run-a-workshop
description: Spin up, hand out, reset, and tear down a hands-on OpenWork workshop (fictional Outlook/Calendar/Drive/Jira/Confluence, one Den, one desktop per attendee) with the `workshop` world. Use when someone asks to prepare a workshop, demo day, training session, attendee VMs, or to reset/clean up after one.
---

# Skill: Run a workshop

One command builds a private, disposable workshop on Daytona:

- **One small Den** (API, web, Gateway, MySQL) in dev mode. Fictional org,
  fictional members, no real email. It is never production Den.
- **The fictional workplace** (Open Outlook, Calendar, Drive, Jira,
  Confluence) running *inside the same world*, behind per-member OAuth. Each
  attendee's browser gets its own private workspace automatically.
- **One desktop per attendee**, each signed in as a different ordinary
  member, reached through a noVNC viewer link.

Everything lives in the world and disappears with `world down`. Nothing is
shared across events, so test runs cannot pollute or exhaust the real event.

**Status (2026-10-20):** one self-contained Daytona backend + ordinary attendee
passed five real OAuth consents, a paid GPT-6.1 Sol task reading all five services,
a local/Drive write, Ctrl+Enter steering, exact data reset, and the same paid task
again without reconnecting. Source was `7d381c9d0f42c37a5537ede6019b7225c1ffc7d0`.
This is **not** a 20-seat or full-workshop-exercise verdict. The canonical exercises
are a separate queue and can expose missing fixtures/capabilities. Never clone an
authenticated pilot; use a separately audited software-only base and fresh profiles.
See `research/workshop-pilot-validation.md` and the template/fanout gates.

## Windows rehearsal (separate verdict)

The `workshop` world's existing desktop fleet is Linux. For a Windows attendee,
use the maintained `preview-desktop` **published release** path, not an unsupported
Windows source preview or a copied authenticated Linux profile:

```sh
pnpm world help preview-desktop --json
pnpm world plan preview-desktop --place daytona --os windows --stage <windows-stage>
pnpm world up preview-desktop --place daytona --os windows --stage <windows-stage> \
  --source desktop=release:<exact-version>/enterprise --seed blank \
  --detach --timeout 600000 -- --lifetime 45
```

Discover an actual stable release with its Windows x64 asset first. The driver
checks release byte count and SHA-256 in the VM. `plan` does not accept `--source`
or `--seed`; those belong on `up`. Install the separate `evals` workspace when
its dependencies are absent; a root install alone can leave `mysql2` unavailable.

Before allocation, GET `/organizations/<actual-org>/usage` and check the
`us` / `windows` pool. A `windows-medium` costs 2 vCPU, 8 GiB RAM and 50 GiB disk;
container capacity is not Windows capacity. Use one uniquely owned stage. Apply
a fixed provider TTL immediately: the launcher adds a 30-minute startup reserve
to its world lifetime, which must not accidentally outlive the event backend.
Keep keys controller-only and viewer/CDP URLs private.

Windows exec is SYSTEM/session 0. GUI installation, app launch, browser sign-in
and OAuth must run in the interactive VNC user's session, with explicit user
profile paths. The maintained launcher uses interactive scheduled tasks; use its
private viewer and CDP witnesses. Normal workshops must **not** install the fake
CA or disable TLS from the certificate-reproduction skill.

Bind only the existing authorized private Den origins, create a distinct ordinary
member and own workspace, and complete real GUI first-launch sign-in. Do not
reuse the Linux attendee/admin desktop session, regenerate OAuth issuer hosts,
change model flags, or reset the shared world. Verify all five consents in the
same Windows browser; scroll each real Allow control into view and verify its
connected callback/Ready state rather than inferring success from a mouse event.
Reuse saved private CDP/viewer origins instead of minting a signed URL per click.
Verify actual model aliases, paid local/Drive writes, Ctrl+Enter
while busy, own-attendee reset and rerun. Only then queue the presenter's eleven
canonical prompts, excluding T07 lockout. Track per-task outcomes honestly.
**Windows result on 2026-10-20 remains Incomplete.** The first launch exposed
an executable-name bug and misleading retained-viewer wording. The maintained
launcher now uses actual distribution-specific filenames, checks Authenticode,
and supports bounded failure retention with `OPENWORK_DAYTONA_RETAIN_FAILED=1`
plus `OPENWORK_WINDOWS_PREVIEW_DEADLINE` (an absolute deadline 1–90 minutes away).
Nine launcher tests pass, and one explicitly authorized replacement proved the
real Enterprise filename/session-1 path and actual failure retention without an
alias. The shipping app binds CDP to loopback 9223; its private relay is 19825.
The viewer is port 6080 with `/websockify`; test HTTP **and** RFB, not HTTP alone.

A single same-VM restart recovered guest transports. A fresh Windows Edge profile
then completed real ordinary-member Den GUI sign-in, with a screenshot. The
member's Den install config advertised **Cloud**, not Enterprise activation:
use the backend-compatible signed distribution, never fabricate activation or
change Den flags. The official signed Cloud 0.18.59 installer also completed on
that same VM. A real first consent was shown, but its callback was not confirmed;
no five-grant pass is claimed. Desktop launch again coincided with intermittent
CDP/toolbox timeouts despite a private relay and disabled GPU. A recovered real
Cloud log reports `Managed OpenCode process did not exit after SIGKILL` during
managed/embedded server startup. CDP later listed the app page but renderer and
WebSocket operations still timed out; transport root cause remains unestablished. No paid task, reset/rerun or canonical exercise ran. All eleven were
**not submitted**. Do not start a fleet or treat the browser screenshot as desktop
acceptance. See `research/workshop-windows-validation.md` for exact evidence,
retention semantics, cost ceiling and the fixed cleanup deadline.

## Before the event (do this first, 5 minutes)

Run every check before allocating any desktop. A failed check is a fix, not
a retry.

1. **Daytona identity: the team org, not a personal one.** Use the `daytona`
   skill. The key needs `DAYTONA_API_URL` too, or the CLI silently uses the
   saved profile:
   ```sh
   export DAYTONA_API_URL=https://app.daytona.io/api
   export DAYTONA_API_KEY="$(infisical secrets get DAYTONA_API_KEY --env dev --path /openwork-ops --plain --silent)"
   ```
   Fetch secrets once into the controller shell (`get-env-var`), never inline
   per command, and never into attendee VMs.
2. **Capacity.** Each sandbox is 4 CPU / 8 GiB / 10 GiB, and that can't be
   lowered for a snapshot. N attendees need N + 1 sandboxes. Check the org's
   memory limit and the **active-snapshot** limit (100 by default; only active
   snapshots count). If either is close, clean up first (see "Daytona quota").
3. **Model key (optional).** Export `OPENAI_API_KEY` in the controller shell if
   attendees should run real agent tasks. It goes into Den's encrypted provider
   storage with a per-member allowance; it never reaches the desktops.
4. **Plan without creating anything:**
   ```sh
   pnpm world plan workshop --place daytona --stage <event>
   ```

## Start

Always start with a **backend-only smoke run**, then the pilot, then the fleet.

```sh
# 1. Backend only: Den, workplace, five connections, one automatic join, reset.
pnpm world up workshop --place daytona --stage <event> --detach -- --count 0
pnpm world outputs workshop --stage <event> --json
pnpm world down workshop --stage <event>

# 2. The event: one pilot desktop is verified before the rest start.
pnpm world up workshop --place daytona --stage <event> --detach -- --count 20
pnpm world outputs workshop --stage <event> --reveal
```

Script options (after `--`):

| Option | Meaning |
|---|---|
| `--count <n>` | Attendees; `0` = backend only. Members are `attendee-01 … attendee-NN` (`@example.test`). |
| `--lifetime <min>` | Daytona: 1-1380, default 720. Capped because the Den and workplace preview links are signed for 24 hours. |
| `--allowance-usd <x>` | Daily model allowance per member, default 5 (only with `OPENAI_API_KEY`). |
| `--model <id>` | Model added to the Gateway, default `gpt-6.1-sol`. |
| `--concurrency <1-4>` | Desktops started at once after the pilot, default 2. |

`--count` is part of the world's identity: run `world down` before changing it.
A non-pilot desktop that fails twice is listed as `failed`; the rest keep
running. There is no single-desktop replace yet: give that attendee a spare
seat (provision one or two extra) or rebuild the world.

## Hand out

Give each attendee **only their own viewer link**. Never share the admin
sign-in, the Den URL, CDP addresses, or another attendee's link. Anyone with a
viewer link controls that whole desktop.

Inside the desktop, the attendee connects the five workplace apps (OAuth,
per member) and runs the exercises. Their workplace data is private to their
desktop's browser profile.

## Reset

Reset is the main operation, not an afterthought:

```sh
node worlds/lib/workshop-reset.ts --stage <event>            # preview, changes nothing
node worlds/lib/workshop-reset.ts --stage <event> --confirm  # reset every attendee's data
```

- **Whole event:** restores every workspace's Outlook/Calendar/Drive/Jira/
  Confluence data to the starting state. Desktops, accounts, browser
  identities and OAuth grants stay, so attendees don't reconnect. The reset key
  is read from the world's outputs; it never appears on a command line.
- **One attendee:** they open the `attendeeReset` URL from their own desktop
  browser; it resets only their data.

For a diagnostic pilot, set `OPENWORK_DAYTONA_RETAIN_FAILED=1` before `world up`
to preserve repairable startup failures (including Den build failures). Record
sandbox IDs as soon as allocation starts, apply a provider TTL, and stop those
owned sandboxes explicitly when finished: a failed world may not have outputs or
a complete cleanup ledger. Do not blindly rebuild a failed pilot or delete shared
resources to recover it. Normal runs still clean up failed startup automatically.

## Tear down

```sh
pnpm world down workshop --stage <event>
```

Then confirm Daytona lists no sandboxes for the event. Desktops also expire
by provider TTL; don't rely on that alone.

## Rules learned the hard way

- **Demo, not production.** Don't add caps (guest or registration ceilings,
  lifetime counters). A 200-guest ceiling, filled by our own test runs,
  blocked a 20-person fleet at attendee 15.
- **Don't run Den in production mode for a workshop.** It rejects localhost
  service addresses, enforces a 32-character password limit, and requires real
  invitation email. Dev-mode Den inside a private world avoids all three.
- **Nothing shared and long-lived.** Don't point workshops at a shared hosted
  workplace (e.g. a Render service). Every rehearsal leaves state there and
  someone eventually hits its limits or can't manage the account it lives in.
- **Preflight before spend.** Check Den health, the workplace's `/health`,
  that a brand-new browser can join, and that all five connections exist
  *before* the first desktop is allocated.
- **Pilot, then fan out** with low concurrency (2). Don't hand out cards from a
  partial run; a later failure tears the fleet down.
- **Daytona defaults are not workshop defaults.** The workshop requests private
  Den/desktop sandboxes (`OPENWORK_EVAL_DAYTONA_PRIVATE=1`) and explicitly signs
  viewers through the event lifetime plus reserve. Verify actual API privacy,
  unauthenticated denial, authorized HTTP **and** RFB/WebSocket before handout.
  The pilot's live check denied the unsigned viewer with HTTP 401 while the signed
  viewer worked. Viewer URLs are bearer credentials: anyone with one controls that
  desktop. Path/query-auth preview shapes fail closed; never strip their token.
  Memory is given in GiB to the CLI.
- **One venue IP.** All attendees reach the workplace through the Daytona
  proxy, so they share its per-IP limits on OAuth client registration and
  pre-join authorization (600/min). Fine for 20 people; watch it for larger
  groups.
- **Redact.** Errors must never contain passwords, tokens, cookies, or signed
  URLs.

## Daytona quota

Only **active** snapshots count toward the snapshot limit. Most active
snapshots come from CI evidence caches (`ow-dy-evidence-image-v1-*`,
`ow-dy-evidence-web-v1-*`) and review checkpoints (`ow-dy-checkpoint-v1-*`);
cleanup rules are in `packages/daytona-evidence/src/cleanup.ts`. Old archived
and errored test sandboxes (`openwork-server-*`, `openwork-connector-*`) can be
deleted after checking nothing needs them. Never delete user Den workers
(`den-daytona-worker-*`) by age alone.

## Local checks (no infrastructure)

```sh
pnpm world up workshop --place local --stage ww-smoke -- --count 0
pnpm world down workshop --stage ww-smoke
```
