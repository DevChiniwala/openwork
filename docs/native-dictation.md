# Native dictation

Status: proposed, behind `nativeDictation`, off by default on cloud and
self-hosted deployments. Enable through the existing Features controls in
`/admin`; this change does not enable a live rollout.

## Experience

The composer stays the focal element. A quiet microphone sits next to Send in
OpenWork and Workbot, including Workbot's chat beside a document. Activate it
to dictate at the current cursor. Existing text, attachments and context stay
in place. The result is editable text, sent only when the person chooses Send.

After activation, Enter adds a line rather than sending. A compact state row
says “Review your text, then send” and offers “Return to typing” to restore
ordinary keyboard submission. Clearing the draft or changing chats resets
that state. This is a review safeguard, not a microphone activity indicator.

| Surface | macOS | Windows | Other devices |
| --- | --- | --- | --- |
| OpenWork desktop | Starts macOS Dictation in the focused editor through AppKit | Opens Windows voice typing with its native Win+H chord | Locked microphone with an explanation; typing remains available |
| Workbot and OpenWork in a browser | Focuses the draft and shows the configured Dictation shortcut / microphone key | Focuses the draft and shows Windows+H | Mobile uses the keyboard microphone; other systems show an explanation |

The browser does not have an API to open the operating system's dictation
panel. It offers the native shortcut rather than recording audio through a
different service. Native panels own listening, stop, language selection and
permission recovery. The app never displays a fabricated listening state.

On macOS, enable Dictation in System Settings › Keyboard. On Windows, voice
typing may require an internet connection, a microphone permission and an
enabled speech language. If desktop activation fails, the same microphone
opens keyboard instructions, preserving the draft. Help closes with Escape,
outside press or “Back to message” and returns focus to the editor.

## Privacy and rollout

OpenWork does not record, upload or retain audio, install a speech model, or
call a speech service. The OS processes speech according to its settings;
this is not an unconditional offline promise. The text follows normal draft
and message behavior. Speech privacy details are disclosed from the help
popover, away from the everyday composer.

The server resolves the registry flag for the current organization. A missing
flag is off. Signed-out OpenWork follows the deployment flag. Disabling the
flag removes the entry point and review state without clearing text or
attachments. An already-open OS dictation panel remains under the person's
system controls; OpenWork does not try to stop system-wide speech input.

Desktop activation is limited to the focused trusted main frame. Windows
rechecks foreground process ownership inside its fixed helper and refuses to
inject its chord while modifier keys are held. No arbitrary command, text,
key or target process is accepted from the renderer.

## Verification boundaries

The PR proof checks the real Workbot UI with a deterministic signed-in API:
flag off, native instructions, focus, review before send, editable draft,
explicit send and compact layout. It does not simulate microphone recognition.
Focused native adapter tests cover frame/focus rejection and helper failures;
real macOS and Windows speech recognition and packaged behavior still need a
hardware acceptance pass before rollout.

Design follows P3, P5, P8, P11, S6, S7, C6, V5 and T5 in `DESIGN.md`.
The interaction takes inspiration from Claude's separate dictation and send
actions. Platform behavior follows
[Apple's Dictation guidance](https://support.apple.com/guide/mac-help/mh40584/mac)
and [Microsoft's voice typing guidance](https://support.microsoft.com/en-us/accessibility/windows/use-voice-typing-to-talk-instead-of-type-on-your-pc).
