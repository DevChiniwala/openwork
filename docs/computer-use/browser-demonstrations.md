# Teach Workbot browser tasks

A member can demonstrate a task in their conversation's browser, explain its
steps in chat, and save the result as a private Cloud skill. This builds on the
shared desktop and input controls; it uses the ordinary skill library and
`create_skill` / `get_skill` tools.

Enable `browserDemonstrations`, `computerUse`, and `remoteComputers` for the
organization in `/admin`. The teaching rollout is off by default on cloud and
self-hosted installations. The conversation needs a desktop snapshot built with
the current guest bridge. An old snapshot reports that teaching is unavailable;
it is never replaced automatically.

## Teach, review, and run

1. Open Computer → Browser → Teach Workbot. Choose the browser tab, then
   Start teaching. The person owns browser input while teaching.
2. Navigate, enter search inputs, and use the page normally. Explain intentions
   in the conversation before or after an action. Workbot receives recent
   semantic steps with the explanation, using read-only turn credentials.
3. Choose Select information, then click a field in the browser. That click
   selects an extraction target instead of activating the page control.
4. Select a recorded step to edit its explanation, input name, or output field.
   Each recorded field edit starts as a parameter; the entered value is omitted.
   Pause recording for activity that should not enter the skill.
5. Finish teaching, name the skill, describe when to use it, and review its
   instructions. Save private skill creates an ordinary private Cloud skill.
6. Supply new inputs and choose Run skill, or ask for the saved skill in chat.
   Workbot reads the skill and operates through its existing browser tools.
   A saved demonstration is labeled Not yet tested; saving does not claim a
   successful autonomous rerun.

The draft includes input placeholders, the taught controls and extraction
fields, teacher explanations, verification requirements, and interruption rules.
The latest explicit correction takes precedence. Ambiguous people or records
require clarification. Page-derived descriptors are quoted untrusted data.
Navigation after an action describes the expected resulting page; replay must
preserve the current search rather than reopening a URL with its query removed.

## Recording boundaries

Recording is limited to the chosen tab's top document and trusted user events.
It does not record other tabs, raw keystroke streams, screenshots, entered field
values, passwords, payment fields, or session credentials. Extraction captures
an accessible field label or table heading rather than its example value.
Page-script-generated clicks do not count as demonstrations. A bounded privacy
filter remembers observed field values only in guest memory for the current
demonstration, so labels that echo cleared or removed values remain redacted
across navigation. That history never enters draft storage or model context.
When its limit is reached, page-derived descriptors are concealed instead of
dropping older protections.

URLs omit query strings, fragments and embedded credentials. Paths, public
control labels, and teacher explanations remain in the private draft: review
these before saving or sharing. The first version supports navigation, ordinary
text inputs, public select controls, clicks, Enter/Tab/Escape, and explicit
extraction targets. Frames, popups, canvas, contenteditable editors, file uploads,
and complex widget gestures need explanation or a separately taught workflow.

The guest stores the draft privately with its owning conversation. Recording
pauses on a lost teaching connection (a 12-second renewable lease) or at 120
steps. A guest process restart recovers a reviewable draft rather than resuming
recording with lost privacy history. Finish reviewing it or discard it to teach
again. Passive draft checks never wake or recreate a paused computer.
Refreshing or reconnecting recovers the recorded steps. The existing
conversation-computer retention policy applies to the draft. Cloud skills have
normal library retention and access rules.

Finish or discard the demonstration before returning the input rail to Workbot.
Stop and takeover remain authoritative during subsequent runs. Read-only
observations can be refreshed while navigation settles; uncertain dispatched
input is never automatically replayed. Turning teaching off denies new requests
and lease renewal while preserving the private draft and saved skills.
