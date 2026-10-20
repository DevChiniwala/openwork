# Independent workshop participants

The opt-in `src/workshop.mjs` entry point puts authentication in front of five fictional workplace apps. Each participant's browser, REST and MCP requests select a private process hosting Microsoft, Atlassian API and Atlassian web servers. Starting the original standalone entry points does **not** enable isolation.

The OAuth flow is real authorization-code + PKCE against **Acme Workplace**, a clearly labeled fictional service. It is not Microsoft Entra or Atlassian account sign-in. No real emails, invitations or password resets are delivered.

## Start locally

From this package, with Node 22.23 or later (no dependency install/build):

```sh
node src/workshop-roster.mjs "$HOME/participants-private.json" 20
OPEN_WORKPLACE_PARTICIPANTS_FILE="$HOME/participants-private.json" node src/workshop.mjs
```

For data and connections to survive restarts, add an absolute private data directory:

```sh
OPEN_WORKPLACE_PARTICIPANTS_FILE="$HOME/participants-private.json" OPEN_WORKPLACE_DATA_DIR="$HOME/workshop-private-data" node src/workshop.mjs
```

The roster generator uses random 256-bit passwords, refuses to overwrite existing files, writes mode `0600`, and never prints credentials. Keep the roster outside git. Each entry has `id`, `name` and `token`; give attendees **only their own** token as the workshop password. IDs and passwords must be unique. Display names may be edited before starting. Never put passwords in URLs or distribute the entire roster.

Open `http://127.0.0.1:3990`. The sign-in form asks for the assigned workshop password, not a real work password. The account identity comes from the roster. HTTP-only cookies keep browser sessions separate. The raw fixtures' fixed tokens are rejected by this ingress.

## Deploy with durable storage

Publish **only the gateway**, not the three raw services. Example Node host configuration:

```sh
HOST=0.0.0.0 PORT=3990 PUBLIC_URL=https://workshop.example.com OPEN_WORKPLACE_DATA_DIR=/var/data/workplace OPEN_WORKPLACE_PARTICIPANTS_FILE=/run/secrets/participants.json node src/workshop.mjs
```

`OPEN_WORKPLACE_PARTICIPANTS` may alternatively contain private roster JSON in the provider's secret environment settings. Never put it in a committed manifest or build argument. `PUBLIC_URL` must be the actual HTTPS origin. Non-loopback HTTP is rejected. Terminate TLS at a trusted platform proxy; forwarded headers do not select the origin or identity.

Mount a **persistent** disk at `/var/data`. A writable ephemeral directory is not durable hosting. SQLite snapshots use WAL, full synchronous commits, atomic writes and private file permissions. Business mutations are saved before acknowledgment. Corrupt/incompatible snapshots and failed writes fail closed; they are not silently replaced with seed data.

Each participant has separate Microsoft and Atlassian database files. A separate database stores only hashed authentication capabilities, identity fingerprints and OAuth metadata; raw browser sessions, authorization codes, access/refresh tokens and roster passwords are not persisted there. Keep the data directory private and back it up using the host's supported disk backup process.

Container option from this package directory:

```sh
docker build -f Dockerfile.workshop -t open-workplace-workshop .
```

Mount the roster read-only and a private writable persistent data directory, supply the settings above, and publish only port 3990. Children use ephemeral **loopback-only** ports. Never forward those ports publicly.

`GET /health` reports `storage: "sqlite"` or `"memory"` and refuses readiness when authentication storage is unavailable. It does not prewarm every participant's backend. Backends start lazily after an authenticated service request and restore their own snapshots. Restrict or retire separate legacy public demo deployments; a new gateway does not secure an unrelated old URL.

## Connect from OpenWork

Use a separate OpenWork member and browser profile for every attendee. Everyone may use the same URLs, but credentials must be **per member**, not one organization-owned shared password.

| Connector | URL |
|---|---|
| Outlook | `https://workshop.example.com/outlook/mcp` |
| Calendar | `https://workshop.example.com/calendar/mcp` |
| Drive | `https://workshop.example.com/drive/mcp` |
| Jira | `https://workshop.example.com/jira/mcp` |
| Confluence | `https://workshop.example.com/confluence/mcp` |

Choose OAuth. The service offers protected-resource and authorization-server discovery, dynamic public-client registration, explicit consent and mandatory S256 PKCE. Sign in with the attendee's workshop password. Consent shows the application, callback host, signed-in account, requested connector permissions and the fictional-data boundary. Allow and Deny both work.

The RFC 8707 `resource` is required at authorization, code exchange and refresh, and must be exactly one of those five connector URLs. Tokens cannot be broadened to the root origin, another connector, arbitrary REST, state inspection or reset. Access tokens last one hour; rotating refresh tokens retain the connection for at most eight hours from its initial grant. Reusing a consumed refresh token revokes its family. `/oauth/revoke` supports disconnecting a client grant. Browser sign-out ends the browser session, not an application's independent OAuth grant.

A participant password can also authenticate direct REST/MCP diagnostics as a bearer. Do not use that shortcut as proof that OpenWork's OAuth flow works. There is no ambiguous combined `/mcp` endpoint.

## Separation and reset

- Mail, drafts, folders, calendar events, binary files and upload sessions are private.
- Jira issues, Confluence pages, comments, history and tool audit are private.
- Identical seeded record IDs never select another participant. A copied record link opens the recipient's own sandbox or returns not found; it is not a sharing link.
- **Reset my sample data** discards only that person's business snapshots and private stack, with explicit confirmation. It leaves other attendees and OAuth connections untouched. Finish active requests before resetting.
- Anonymous APIs/downloads/previews, fixed demo tokens, cross-origin requests and raw `/state`/`/reset` are refused. Password-authenticated verification can inspect `/_workshop/state/microsoft` and `/_workshop/state/atlassian`; OAuth connector tokens cannot.
- Participant session, grant, request and pending-upload limits cannot evict another attendee's live work. Authenticated approval limits account for a shared venue/proxy IP.

Drive upload URLs are intentionally narrow preauthorized capabilities, matching the Graph-like contract. A random gateway token permits one PUT to one participant's pending file, expires after 15 minutes, and is consumed on success. It cannot read files. A supplied different participant identity is refused. Treat upload URLs as secrets. Their transient gateway routing is not retained across restart; retry an interrupted upload with a new session. Completed file bytes are durable.

## Suggested workshop tasks

These are realistic participant prompts, not claims of a passing model run. Read the verification report for the exact tasks actually exercised.

1. **Customer preparation:** “Read the Northwind pilot email and the shared pilot brief. Make one PowerPoint slide explaining what is verified and what still needs acceptance, save it to my Drive, and draft a reply in the existing thread with the link. Don't send it.”
2. **Ordinary follow-up:** “Create an engineering task for the aisle C Wi-Fi roaming test before the pilot readiness decision. Add a clearly labeled follow-up to the relevant Northwind account page, linking the task and preserving the existing content.”
3. **Calendar:** “Find the customer review in my calendar and move it to tomorrow afternoon, keeping the same attendees. Tell me the final date, time and time zone.”
4. **Trust:** “What does our internal documentation say about bringing a dog to the office? If there isn't a policy, say what you couldn't find.”
5. **Reuse:** After reviewing a successful task, save it as an OpenWork skill and run it with another customer's context. Sharing skills is an OpenWork feature, separate from these service sandboxes.

Do **not** include the Windows login/password-reset exercise. It is not part of this workshop's acceptance scope.

## Capacity, recovery and limits

- With a persistent data directory, business data, browser sessions, OAuth clients and token grants survive orderly restarts. The eight-hour grant/session deadlines still apply. Without it, restart restores the seed and requires reconnecting.
- A failed backend stays unavailable until explicitly recovered/reset; never imply it silently restarted successfully. SQLite corruption requires restoring a trusted backup rather than reseeding over it.
- This is fictional data separation, **not an OS sandbox for hostile code**. Participants receive no shell/process access. All stacks share host capacity.
- One Node process per active attendee hosts three private loopback servers. Separate attendees still have separate OS processes; sharing the runtime within one account reduces memory overhead. The roster ceiling is 100, not demonstrated hosting capacity. Validate the actual attendance, task mix, files and hosting plan; a free 512 MiB instance is not assumed sufficient.
- Each attendee has at most 16 concurrent proxied operations, 64 pending uploads, 10 MiB request/file and 60 MiB file storage limits. Proxy response bodies are capped at 16 MiB. Size the persistent disk for snapshots, WAL and backups as well as files.
- Passwords are possession credentials, not verified email identities. Remove or rotate an entry and restart to revoke its restored identities. Other attendees' persistent data remains, but access during deployment can be briefly interrupted.
- OpenWork organization sharing, inference quotas, skills and conversations are separate boundaries. This gateway does not change them.
- Office previews extract safe text; they are not a full PowerPoint editor or visual-rendering guarantee. Verify generated decks separately before presenting.

## Verify

```sh
node --test --test-concurrency=1 src/*.test.mjs
```

These Node 22.23+ tests cover service behavior, cross-participant boundaries, OAuth protocol, real Chrome sign-in/consent, durable restart and failed-storage behavior. Set `CHROME_BIN` if Chrome is not at the standard macOS path. `OPEN_WORKPLACE_SCREENSHOT_DIR` retains private screenshots; never commit them. SQLite's experimental warning is expected on the supported Node release.

The default `evals/proofs/workshop-oauth.proof.test.ts` runs the real Den browser OAuth client with two members and independently executes private Drive work through their OAuth-backed MCP grants. It makes no model calls and requires no paid-model key, so it belongs in the automatic PR proof lane.

Paid acceptance rehearsals are explicit manual scenarios rather than automatic PR proofs:

- `scenarios/workshop-live/e2e.test.ts`: actual OpenWork + Sol, sourced PowerPoint and unsent threaded reply, ordinary Jira/Confluence follow-up, second-member isolation.
- `scenarios/workshop-calendar-trust/e2e.test.ts`: actual OpenWork + Sol, existing-review reschedule preserving attendees, and an honest internal-policy no-answer.

Use Node 24+ for the testkit controller. Select `--local --engine v2 --surface web`, explicitly set `OPEN_WORKPLACE_LIVE_PROOF=1` and `OPENWORK_EVAL_LIVE_OPENAI=1`, and scope the paid `OPENAI_API_KEY` to that command. For example, run `pnpm evals:e2e scenarios/workshop-live/e2e.test.ts --local --engine v2 --surface web` with those settings. To use the hosted gateway rather than a fresh local fixture, also supply `OPEN_WORKPLACE_TEST_URL` and `OPEN_WORKPLACE_TEST_PARTICIPANTS_FILE` pointing to **exactly two reserved test accounts**, never the attendee roster. Browser verification supports those same two settings.

These paid scenarios deliberately are not selected automatically by the PR-proof workflow: they require explicit spending consent and may modify an operator-owned hosted workshop. CI instead runs the no-paid-model OAuth proof above; no CI gate is disabled or represented as paid-model coverage. Do not substitute standalone gateway tests or a mock-model demo for real agent acceptance, and do not call unexecuted/skipped scenarios passed. Local tests alone do not establish deployed TLS, capacity or hosted OAuth compatibility.
