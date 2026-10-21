---
name: launch-workshop
description: Start, check, hand out, fix and stop a hands-on OpenWork workshop (one private Den + one Daytona desktop per attendee, fictional Outlook/Calendar/Drive/Jira/Confluence). Use when the user says "start the workshop", "give me N workshop desktops", "send me the workshop links", "seat N is stuck", "reset the workshop" or "stop the workshop".
---

# Launch a workshop

The day-of scripts live in the facilitator's private folder:
`/Users/benjaminshafii/Documents/Workshops/enterprise-day-in-the-life/day-of/`.
They wrap the tested world `worlds/workshop-pair.ts` (one Den + N seats from a
clean snapshot; a failed seat never tears down the others) and
`worlds/workshop-pair-check.ts` (per-seat checks). Never print viewer links
anywhere except the facilitator's own conversation: each link controls one
attendee's desktop.

## "Start the workshop" (default 20 seats)

1. Timing: start 60–120 minutes before the session, never more than ~3 hours
   before (workplace OAuth approvals last about 8 hours).
2. Run, in the foreground (it takes ~6–10 minutes):
   ```sh
   cd /Users/benjaminshafii/Documents/Workshops/enterprise-day-in-the-life/day-of
   ./start-workshop.sh <seats> <lifetime-minutes> <stage>
   ```
   Defaults: `20 360 event`. If the stage already exists, use a new stage name
   (`event2`) instead of reusing or deleting someone else's run.
3. Read the `READY: x/y` line. For each `NOT READY` seat run
   `./seat.sh attendeeNN prepare <stage>` once. Report anything still failing
   with its one-line reason; do not retry in a loop.
4. Spot-check one seat: `./seat.sh attendee01 status <stage>` then
   `./seat.sh attendee01 task <stage>`; both must print `PASS`.
5. Give the facilitator the hand-out messages:
   ```sh
   ./links.sh <stage>
   ```
   Reply with that output verbatim (one block per seat) so they can paste each
   block into a private chat message to one attendee. Remind them: one link per
   person, never post the list in a shared channel.

## During the workshop

| Request | Command |
|---|---|
| Seat frozen / black screen | `./seat.sh attendeeNN unlock <stage>` (tell the attendee to reload the page) |
| Task stuck / running forever | `./seat.sh attendeeNN stop <stage>` |
| "My data is a mess" | `./seat.sh attendeeNN reset <stage>` |
| Model missing / no composer | `./seat.sh attendeeNN prepare <stage>` |
| Is this seat OK? | `./seat.sh attendeeNN status <stage>` |
| Resend a link | `./seat.sh attendeeNN link <stage>` (send privately) |
| Reset everyone's sample data | `../hosted/reset-demo.command` (the facilitator must type RESET themselves) |

Reset restores Outlook/Calendar/Drive/Jira/Confluence sample data only; it
keeps sign-in and connections, and does not erase chats or desktop files.

## "Stop the workshop"

```sh
./stop-workshop.sh <stage>
```

It must end with `none`. Only tear down a stage the facilitator named.

## Rules

- One Den + N seats, each seat a different ordinary member with a $5 model
  allowance; the shared model key stays in Den, never on a desktop.
- The desktop snapshot is clean (no sign-in, cookies or keys). Never snapshot a
  signed-in desktop.
- Desktops run in the attendee's time zone (default America/Los_Angeles).
- Don't bypass-merge to run a workshop; the scripts run from the branch.
- If Daytona answers "Too Many Requests", the world already retries; if a whole
  wave fails, rerun with a new stage rather than deleting resources by hand.
