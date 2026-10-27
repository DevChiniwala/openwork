# OpenCode engine and earlier chat history

OpenWork runs one engine: OpenCode v2 (`opencode2`, pinned by
`constants.json` `opencodeV2Version` and integrity-checked through
`apps/server/src/opencode-v2-artifacts.json`). The server starts it itself.
OpenCode v1 is no longer shipped, started, proxied or selectable: there is no
engine switch, no manual or pinned v1 choice and no rollout flag. The retired
`engineV2ForceUpgrade` / `engineV2Upgrade` values remain ignored, and the
former local overrides (`OPENWORK_ENGINE_V2_PREVIEW`,
`OPENWORK_ENGINE_AUTO_UPGRADE`, `OPENWORK_FRESH_INSTALL_ENGINE`,
`OPENWORK_ENGINE_FORCE_POLICY`, `OPENWORK_OPENCODE_BIN`) are no longer read.

The earlier engine's routes (`/opencode/*`, `/w/:id/opencode/*`,
`/workspace/:id/opencode/*`) answer `410 opencode_v1_removed`. Clients use
`/workspace/:id/opencode2/*`.

## Earlier chats are copied automatically

Chats saved by OpenCode v1 live in its SQLite database (`OPENCODE_DB`, or
`opencode/opencode.db` in the XDG data folder). When the server starts and
that database has chats no finished copy covered, it copies them into
OpenCode v2 before v2 serves this profile. There is no consent step: the copy
only reads the original. `GET /experimental/engine-v2-preview/status` reports
`historyImportPending` and `migration` (phase, counts, receipt); the desktop
shows its non-blocking progress banner while the copy runs, and the engine
proxy answers `503 engine_v2_preview_not_running` until it finishes. Chats
created in v1 after an earlier copy's cutoff are copied on a later start.

The copy is the existing staged migration (`opencode-v2-migration.ts`), which
needs only the v1 database and the pinned `opencode2` binary:

- It snapshots the v1 database (including committed WAL writes); the original
  file is never written.
- Durable stages: snapshot, reversible payload externalization, native
  conversion, payload restoration, transactional transfer. Large payloads stay
  in SQLite; no chat is trimmed. Each stage and transfer batch checkpoints, so
  closing OpenWork pauses the copy and the next start resumes it.
- Existing v2 chats are skipped unchanged. Every original v1 message, part and
  session row is also archived byte-for-byte (`openwork_v1_message`,
  `openwork_v1_part`, `openwork_v1_session`). Existing v2 history is backed up
  before the transfer; the two most recent backups stay on disk.
- A pending-copy fence keeps every managed engine instance off the target
  database while a transfer is unfinished.

### When a copy fails

A failed copy never deletes or rewrites the original v1 database, and OpenCode
v2 still starts so new chats work:

- A failure before the transfer stage leaves v2's history untouched; the
  conversion checkpoint is kept and the next attempt resumes from it.
- A failure during the transfer restores v2's database from the backup taken
  when the transfer began (v2 was closed from that backup onwards, so nothing
  is lost), then lifts the fence. The next attempt takes a fresh backup. If no
  backup was recorded, the fence and files stay and v2 stays closed rather than
  serve partly copied history.
- Unreadable or invalid history is not treated as empty. The error is kept in
  the status receipt, and copies back off from one minute to one day between
  starts. The app can retry immediately with
  `POST /experimental/engine-v2-preview/migrate` (host token).

Opening a v1 chat that has not been copied yet explains that it is still being
copied or will be copied on a later start.

### Upgrading from earlier OpenWork versions

The saved engine state (`engine-v2-preview.json` in runtime storage) keeps
working: copy receipts, cutoffs and resume markers are read as before, and the
former engine choice fields (`enabled`, `chatRouting`, `engineOrigin`, ...)
are ignored. Profiles that were still on v1 are copied on their first start.
A copy that an earlier version made while v1 kept serving, and that never
served v2, is restored to its pre-copy backup and copied again when the v1
history changed since (as before).

Limits: v1 chats that were already copied and then continued in v1 (for
example after a manual switch back in an earlier version) keep their v2 copy;
the later v1 messages stay in the original database and its archive, but are
not merged. OpenCode's conversion resets session permissions and revert state
and normalizes interrupted activity.

## Credentials and providers

API keys people saved with OpenCode v1 stay where they were (`auth.json` in
the OpenCode data folder). OpenWork now owns that file: the app saves and
removes keys through `PUT|DELETE /workspace/:id/opencode2/auth/:provider`,
which writes it atomically (mode 0600, keeping every other entry) and then
mirrors keys into OpenCode v2. Built-in provider metadata comes from the same
model catalog OpenCode v2 reads (`OPENCODE_MODELS_URL`), cached for offline
starts. Provider sign-in (OAuth) is not available on this engine yet; such
providers are listed as needing a sign-in OpenWork cannot use.

## Upstream contract reviewed

Implementation was checked against the native engine at the repository pin,
`2.0.26`, and its upstream source commit
`9b4ec5714d481559990db0a816d5dec19541a814`:

- [Native migration](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/core/src/database/v1-migration.bun.ts)
- [Migration status API](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/protocol/src/groups/migration.ts)
- [Native session transfer](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/core/src/session/transfer.ts)
- [V1 compatibility guide](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/services/www/src/docs/content/migrate-v1.mdx)

## Verification

- `apps/server/test/opencode-v2-staged-history.test.ts` runs against the
  pinned real engine: large payloads, interrupted workers, resume, automatic
  copy on boot before v2 serves, no second copy on restart, and v2 still
  serving when history cannot be copied. Without a binary it skips.
- `apps/server/test/opencode-v2-history-release.test.ts` covers returning v2
  history to its pre-copy state after a failed transfer.

```sh
OPENWORK_OPENCODE2_BIN="$(command -v opencode2)" pnpm --filter openwork-server test:history-migration
```
