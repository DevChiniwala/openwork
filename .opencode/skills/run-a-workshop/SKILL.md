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

**Status:** the backend (`--count 0`) is verified locally. The Daytona path
(preview URLs, OAuth through them, attendee desktops, live model allowance)
has not been run end to end yet. Do the smoke run and the pilot below before
promising anything to attendees.

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

If something is badly broken, `world down` and `world up` again: a fresh world
is faster than debugging state.

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
- **Daytona defaults are not workshop defaults.** Sandboxes and preview ports
  are public unless requested private, and preview links may expire after an
  hour unless an expiry is set. Memory is given in GiB to the CLI. Desktop
  viewer links are currently unsigned public-sandbox URLs: anyone with one
  controls that desktop until `world down`, so treat each as a secret.
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
