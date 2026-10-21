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
A cold software-only snapshot and a second, freshly signed-in ordinary-member
canary subsequently passed five consents, paid inference and cross-member file
isolation. The remaining 18 seats were **not allocated**: the existing event's
remaining-lifetime gate required explicit renewal. The Linux canonical queue
finished with **8 passed / 3 incomplete or blocked**, not an all-green workshop.
Never clone an authenticated pilot. See `research/workshop-pilot-validation.md`
for exact software/operator SHAs, outcomes, limitations and reproducible HOW.

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

# 2. One real attendee pilot. Startup alone is not the full acceptance gate.
pnpm world up workshop --place daytona --stage <event> --detach -- --count 1
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

`--count` is part of the world's identity. Do not turn the approved one-seat
world into a 20-seat world by restarting it: that replaces its backend, signs in
every attendee, and only gates on desktop startup—not completed exercises.

For a signed-out fleet, preserve the shared backend and use the isolated
`worlds/lib/workshop-replicate.mjs <private-receipt.json> <fixed-deadline-ISO>`
controller after the functional pilot passes. It validates one fresh canary from
an audited software-only snapshot, then explicitly gates the remaining 18 seats
(20 total including the original pilot and canary), concurrency two. No automatic
fanout or deadline extension; no per-seat snapshots/volumes. Follow the report's
HOW and use measured receipt facts, not hand-filled readiness booleans. A failed
owned canary is retained/repaired by its ID, not replaced by a restart loop.

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

Then confirm Daytona lists no owned sandboxes for the event. Verify each VM's
actual provider `autoDestroyAt`; do not assume ordinary world startup set a hard
provider TTL. The isolated replication controller sets and checks it explicitly.
Never rely on process lifetime or provider TTL alone, and coordinate shared-backend
teardown with other active lanes.

## Rules learned the hard way

- **Demo, not production.** Don't add caps (guest or registration ceilings,
  lifetime counters). A 200-guest ceiling, filled by our own test runs,
  blocked a 20-person fleet at attendee 15.
- **Don't run Den in production mode for a workshop.** It rejects localhost
  service addresses and requires real invitation email. Use development mode
  inside a private world. **Development mode still rejected a password longer
  than 32 characters in the live canary**: generate a valid password and validate
  its length before creating the invitation; do not assume dev mode removes that
  auth schema limit.
- **Nothing shared and long-lived.** Don't point workshops at a shared hosted
  workplace (e.g. a Render service). Every rehearsal leaves state there and
  someone eventually hits its limits or can't manage the account it lives in.
- **Preflight before spend.** Check Den health, the workplace's `/health`,
  that a brand-new browser can join, and that all five connections exist
  *before* the first desktop is allocated.
- **Full pilot acceptance, then fan out** with low concurrency (2). Desktop
  startup alone is not acceptance. Don't hand out a partial fleet; retain the
  exact failed owned seat for diagnosis and report incomplete counts honestly.
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
