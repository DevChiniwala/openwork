# Computer use in the background

- **Feature key:** `computerUseBackground`
- **Deployments:** cloud and self-hosted
- **Author:** reachjalil
- **Default:** off. Needs `computerUse`.

## What people get

On a Mac, an agent with control of an app window works in that window where
it is. The window is not brought to the front, the person's cursor does not
move and their Space does not change, so they keep working in their own apps.
Several chats can each work in their own window at the same time.

Agents also read the window's accessibility tree first. An observation skips
the screenshot when the tree names at least eight controls to act on, and the
agent asks for an image (`include_image: true`) when it needs coordinates.

Blender and Unity read only real pointer input, so sessions in those apps keep
the current behavior and come to the front, taking turns with other chats.

## How it works

- Desktop reports the feature to the computer broker
  (`computerSetBackgroundEnabled`). New sessions on This Mac start the helper
  with background delivery; turning it off hands idle sessions back and the
  next call reopens them in the foreground.
- The helper decides per session (`InputDelivery`): background for control
  sessions, foreground for canvas apps or when the private calls below are
  missing on that macOS. The open result and every action receipt carry
  `delivery`.
- Background input makes the window its app's key window without raising it
  (WindowServer event records through `SLPSPostEventRecordTo`, never
  `SLPSSetFrontProcessWithOptions`), posts pointer events to the app's process
  (`SLEventPostToPid` for Chromium, Electron and Catalyst apps, `postToPid` for
  others), posts keys to the app's process, and primes Chromium's user-gesture
  check with a press outside every window before a click.
- Keys are sent only when the target window is the app's key window and the
  observed field still has focus; otherwise nothing is typed
  (`background_keys_unavailable`).
- Background sessions skip the per-computer turn queue, the focus lock and the
  typing-gap wait. The person's own clicks and typing stop a background step
  only when they are in the agent's app.

## How to try it

1. Turn on `computerUse` and `computerUseBackground` for your organization.
2. Ask an agent to work in TextEdit or Notes while you keep using another app.
3. Run the real-app check with the desktop open:
   `pnpm --filter @openwork/computer-use prove:mac-apps`. Each action receipt
   includes `desktop.front_app_changed`, `desktop.cursor_moved` and
   `desktop.space_changed`; in background sessions all three should stay
   `false` unless the person moved something themselves.

## Turning it off

The kill switch or turning the feature off hands idle sessions back at once;
a call already running finishes as it started. The next call opens a
foreground session, the behavior before this feature. Nothing is stored.

## What to watch

- Receipts with `delivery: "background"` and `settled: false` or
  `background_keys_unavailable`: the app ignored background input. Add its
  bundle id to `InputDelivery.foregroundBundlePrefixes`.
- The private SkyLight calls can change with a macOS release. When a symbol is
  missing, sessions fall back to the foreground on their own; check the
  real-app run on each new macOS.
