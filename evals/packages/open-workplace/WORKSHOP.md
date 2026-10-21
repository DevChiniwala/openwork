# Automatic private workshop workspaces

Open the workshop link. A new browser automatically receives its own private fictional workplace, and returning in that browser restores it. **No password, account card or registration step is needed.**

Each person must use a separate browser profile. This is a private **browser workspace**, not a verified email/person identity: people sharing a browser profile share its workspace. Clearing cookies, closing an incognito profile or switching devices starts a new one. Do not use real company data.

## Start

From this package, with Node 22.23+ and no dependency install:

```sh
node src/workshop.mjs
```

Open `http://127.0.0.1:3990`. For durable business data and browser/OAuth sessions:

```sh
OPEN_WORKPLACE_DATA_DIR="$HOME/workshop-private-data" node src/workshop.mjs
```

The CLI defaults to `OPEN_WORKPLACE_JOIN_MODE=automatic`. Existing assigned-account fixtures remain available with `OPEN_WORKPLACE_JOIN_MODE=assigned` and a private roster for backwards-compatible tests; the public automatic entry point never displays or accepts their sign-in form. Existing connected accounts are not deleted by switching modes.

## Hosting

Publish **only** the gateway, not the raw fixture ports. Example:

```sh
HOST=0.0.0.0 PORT=3990 PUBLIC_URL=https://workshop.example.com OPEN_WORKPLACE_DATA_DIR=/var/data/workplace OPEN_WORKPLACE_JOIN_MODE=automatic node src/workshop.mjs
```

Use a real persistent disk at `/var/data`, not an ephemeral writable directory. Hosted origins require HTTPS. Backend servers bind private loopback ports in one process per active workspace. The gateway uses its configured origin, not caller-supplied forwarding headers.

SQLite snapshots use WAL, atomic writes, full synchronous commits and private file permissions. Business writes are committed before acknowledgment. Authentication storage contains guest identity fingerprints and hashed browser/OAuth capabilities, not user-entered passwords or raw session/access/refresh tokens. Invalid storage fails closed rather than silently reseeding.

`GET /health` reports `joinMode: "automatic"`, `storage: "sqlite"` or `"memory"`, isolation and a startup timestamp; unavailable auth storage refuses readiness. Backends restore lazily on the first service request.

The optional `Dockerfile.workshop` builds the same standalone package. Supply the configuration above, mount private persistent storage and publish the gateway only. Separate legacy public demo deployments are not secured by this entry point; do not use them as no-auth alternatives.

## Connect from OpenWork or another MCP client

Use OAuth with **per-member credentials**, not a shared organization connection. Everyone uses the same URLs:

| Connector | MCP URL |
|---|---|
| Outlook | `https://workshop.example.com/outlook/mcp` |
| Calendar | `https://workshop.example.com/calendar/mcp` |
| Drive | `https://workshop.example.com/drive/mcp` |
| Jira | `https://workshop.example.com/jira/mcp` |
| Confluence | `https://workshop.example.com/confluence/mcp` |

Transport: Streamable HTTP. On the first connection, the browser automatically joins a private workspace and shows the consent page. Check its guest label and permissions, then choose **Allow workplace access**. Later connectors in the same browser use that same workspace. Different browser profiles receive different workspaces.

OAuth consent is still explicit. Opening an authorization URL does **not** grant an app access automatically. Deny works. The service is clearly labeled **Acme Workplace / fictional workshop sandbox**, not Microsoft Entra or Atlassian sign-in.

The server supports discovery, dynamic public-client registration, mandatory S256 PKCE, rotating refresh tokens and `/oauth/revoke`. The exact MCP URL is required as the RFC 8707 `resource` at authorization, code exchange and refresh. Tokens cannot be widened to another connector, arbitrary REST, state inspection, reset or root. There is no combined `/mcp` endpoint.

Access tokens last one hour; refresh grants last at most eight hours from initial approval. Reusing a consumed refresh revokes its family. After grant expiry, approve again from the same remembered browser to retain the workspace. Automatic browser sessions last 30 days. Secure hosted cookies are HTTP-only, host-only and SameSite=Lax so legitimate top-level OAuth redirects reuse the workspace across client origins; unsafe mutations still require same-origin protection.

## Isolation and lifecycle

- Mail, drafts, folders, calendars, files, Jira issues, Confluence pages/comments/history and audits are private to the workspace.
- Identical seeded record IDs cannot select another workspace. A copied link opens the recipient browser's own data or returns not found; it is not a sharing link.
- Opening the link restores an existing browser workspace without consuming a new guest slot.
- **Forget this browser’s workspace** explains the loss of browser access and asks for confirmation before clearing the session. It lands on a signed-out page without immediately creating another workspace or revoking independent OAuth app grants. There is no account/password recovery for a forgotten browser identity.
- **Reset my sample data** explicitly deletes only this workspace's business snapshots. It does not affect other attendees or silently erase data on a normal restart.
- Anonymous MCP/API/download/preview requests remain unauthorized. Automatic joining happens only on valid browser navigation, not arbitrary API calls, embedded frames or fetches.
- Drive upload URLs are narrow, expiring, single-use PUT capabilities; they cannot read files or select another identity. Pending gateway upload routes do not survive restart/worker eviction; retry interrupted uploads with a new session. Completed file bytes do survive.

This is not cross-device account synchronization or an OS sandbox for hostile code. Keep each attendee in their own browser profile. No real emails, invitations or password resets are delivered.

## Public-join capacity

- `OPEN_WORKPLACE_GUEST_LIMIT` defaults to **200** remembered guest workspaces (maximum 1000); existing sessions are not evicted to make room for new guests.
- New guest creation is bounded per IP to accommodate a venue cohort while limiting public allocation abuse.
- `OPEN_WORKPLACE_WORKER_LIMIT` defaults to **32** active private processes. With durable storage, idle workers can be reclaimed after one minute and restored without deleting acknowledged work. In-memory work is never silently evicted.
- When all active workers are busy, a new service request receives a retryable capacity response rather than starting unbounded processes.
- Each workspace retains the fixture's 10 MiB request/file and 60 MiB file-storage limits, bounded request concurrency and pending uploads. Audit values are truncated/hash-recorded when large, not multiplied indefinitely as binary history.
- Roster/guest ceilings are configuration limits, not a promise of maximum-load capacity. Measure the actual attendance/task mix and size memory/disk accordingly.

## Suggested tasks

1. “Read the Northwind pilot email and shared pilot brief. Make one PowerPoint slide explaining what is verified and what still needs acceptance, save it to my Drive, and draft a reply in the existing thread with the link. Don't send it.”
2. “Create an engineering task for the aisle C Wi-Fi roaming test before the pilot readiness decision. Add a labeled follow-up to the relevant Northwind account page, linking the task and preserving existing content.”
3. “Move the existing Northwind / Blue Harbor customer review to tomorrow at 2pm Los Angeles time, keeping its attendees and duration.”
4. “Does our internal office guidance allow dogs? If you can't find a policy, say so rather than inventing one.”

Do not include the Windows login-lockout exercise. Office text previews are not a full editor; visually check generated PowerPoints separately.

## Verification

```sh
node --test --test-concurrency=1 src/*.test.mjs
```

Use Node 24+ for the testkit controller. `evals/proofs/workshop-oauth.proof.test.ts` runs actual automatic joining and consent through the real Den client with two browser profiles, executes OAuth-backed Drive work and checks separation without paid inference. It supports `OPEN_WORKPLACE_TEST_URL` for an explicitly selected owned hosted gateway; no attendee roster is needed in automatic mode.

Explicit paid scenarios under `scenarios/workshop-live` and `scenarios/workshop-calendar-trust` retain assigned-mode fixture setup for repeatable development. Their earlier hosted results predate automatic joining; do not present those as a new passwordless-model rehearsal. The automatic OAuth proof and browser/API restart tests validate the changed boundary. Never describe skipped cases or unjudged screenshots as passed visual claims.
