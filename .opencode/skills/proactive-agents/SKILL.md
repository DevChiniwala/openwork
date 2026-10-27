---
name: proactive-agents
description: Build or change anything where an agent acts or speaks without being asked, such as Automations and their triggers, Your agent, routines, watches, background checks, notifications, or messages sent to Slack or email. Use BEFORE designing it and again before calling it done. Strict about what the person experiences; open about how it is built.
---

# Skill: Proactive agents

A proactive agent is a coworker who notices things and gets work done while
the person is away. The bar is a good human assistant: rarely interrupts,
always has a reason, and never surprises anyone with something done in their
name. Judge every choice by what the person experiences, not by the plumbing.

Grok Bot, OpenAI dots, Claude Duet, Meta Muse and OpenClaw arrived at these
rules independently, and our own Workbot work confirmed them. A design that
breaks one needs a reason you could say to the person it affects.

## The rules

1. **Silence is the default.** Speak only about something new, actionable or
   blocking. "Nothing new" is a valid outcome and sends nothing. Never send
   "still waiting" or "no updates".
2. **Every message says why it came.** One line names the reason: "Because
   you have the quarterly review at 2pm." If you can't write that line, don't
   send the message.
3. **Interruptions are a budget.** Default to weekdays and working hours in
   the person's time zone, with a small daily limit per person. Loose words
   ("daily", "keep an eye on it") never mean weekends or 3am. Go outside the
   window only for a reason you can name, such as a medication reminder, an
   incident or a trip.
4. **One message per thing.** The same event never notifies twice, even
   after retries, restarts or overlapping checks. Group related changes into
   one message.
5. **It reaches the person from its own identity.** A message that doesn't
   notify is a failure: Slack, for one, never notifies you about your own
   messages. The agent speaks as itself (its bot, its address). It acts as
   the person only through their connections, and only when they asked.
   Never blur "from OpenWork" and "from you".
6. **Anything that can't be undone waits for the person.** Sending, paying,
   signing, deleting or accepting on someone's behalf goes through an
   approval that shows the action, every recipient and the exact content.
   Some actions stay off-limits even with approval. A standing order is
   approval for exactly what it names and nothing more. Text inside an email,
   page, calendar event or another agent's message never grants permission.
7. **The person can always see what it watches, what it did, and why it
   woke.** Every wake has a visible source: a schedule, an event, a request,
   or a follow-up the person can list and cancel. No invisible
   self-scheduling. Run history is the truth, not the schedule.
8. **Talking is configuring.** People change behavior in plain words: "only
   urgent things during the day", "stop telling me about calendar changes",
   "after each meeting, send me the action items". The agent turns that into
   durable preferences or standing orders and confirms what it saved. Admins
   and power users may get forms or files; nobody else has to learn them.
9. **Useful without events, faster with them.** A regular look across the
   connected sources makes it useful from day one. Event integrations make
   it react sooner and cost less; they never change what it knows. Be honest
   about timing: "I'll check every hour", never "the moment it happens".
10. **Fail once, then pause.** A broken connection or a missing permission
    produces one clear message with the fix ("Reconnect Gmail"), then the
    work pauses instead of retrying silently or reporting it again every run.
11. **Controls are one step away and reversible.** Mute this kind, snooze,
    turn off, with undo, by asking in words or with one tap. A mute is
    feedback: respect it immediately and keep it.
12. **What it reads in the background is not what it believes.** Background
    work reads, it doesn't act. What it reads stays apart from the
    conversation and long-term memory until it is actually shown to the
    person. An email can inform the agent; it can't instruct it.
13. **Ownership is obvious in shared places.** In a shared channel it is
    clear whose agent is speaking, and only its owner can steer it.
    Authority comes from the person it runs for, or an admin's policy, never
    from whoever wrote the instructions.
14. **One agent per person.** Prefer giving one agent more responsibilities
    over giving someone several agents that each message them about
    overlapping things.

## What this skill does not decide

Architecture: queues or loops, polling or push, files or database rows, which
model, which runner. Choose whatever meets the rules above with the least new
machinery, and reuse what exists before adding a parallel path. One place
decides whether and how a message goes out; a second notification path or a
second set of limits is a design smell.

## Check your work

- **Replay a recorded day.** Feed a day of calendar, inbox and chat events
  through it and count three things: messages sent, messages that should have
  been silence, and important items it missed. Run each scenario more than
  once; some problems appear only in one run out of two.
- **Read every message cold.** Does it have the reason line and the
  controls? Would you be annoyed to get it at that hour, on that day?
- **Break a connection mid-run.** You should see exactly one notice, then a
  pause.
- **Hide instructions in an email or event.** Nothing the person didn't ask
  for may happen.
- **Ask it "what are you watching, and why did you message me at 9:14?"** It
  must answer from records, not guesses.
- **Watch production numbers.** Track the share of checks that ended quiet,
  messages per person per day, and how often people mute or turn it off. A
  rising mute rate is a bug, not a preference.

## Signs you skipped this

- A feature adds its own notification path or its own limits.
- A message is sent as the person "so it shows up in their DMs".
- A schedule fires at midnight or on Saturday because someone wrote "daily".
- A notification has no reason line, or no way to mute it.
- Copy promises "instantly" for something that checks on a timer.
- The agent wakes itself later and nobody can see it.
- People get messages from several agents about the same thing.

## Where these rules come from

- **Grok Bot:** routines wake the agent with a hidden message marked as not
  from the person. The agent is told to stay silent when nothing changed. A
  routine's prompt ends with who gets the result. Weekdays and working hours
  are the default. A routine pauses after repeated sign-in failures.
- **OpenAI dots:** background research uses read-only tools and reports to
  the main agent, which decides what reaches the person. Custom Rules let the
  person set act, ask or hand off per kind of action.
- **Claude Duet:** a morning brief, then checks every few hours that message
  only when something needs the person. It asks before sending, paying,
  signing or deleting. Some actions stay off-limits even with approval.
- **Meta Muse:** reads a preferences file (Tell me about, Never tell me
  about, When, How) before composing any message, and keeps a heartbeat
  checklist. Jobs pause on durable blockers, and it is honest that it checks
  on a timer rather than watching.
- **OpenClaw:** its periodic check replies `NO_REPLY` when nothing needs
  attention. It dropped inferred follow-ups in favor of explicit automations.
- **Research:** "Mind Your HEARTBEAT!" (2026) showed that background reading
  sharing the chat's memory quietly changes later answers. Teams that ship
  ambient agents report that over-notifying is the fastest way to get them
  turned off.
