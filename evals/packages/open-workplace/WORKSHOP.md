# Independent workshop participants

The opt-in `src/workshop.mjs` entry point puts authentication in front of the five fictional workplace apps. A participant's identity selects a private Microsoft service, Atlassian API and Atlassian web process. The raw fixtures retain their existing private-eval behavior; **starting their old entry points does not enable isolation**.

This is workshop authentication, not Microsoft Entra or Atlassian account sign-in. No real mail, invitations, password resets or external service delivery occurs.

## Start locally

From this package, using Node 22 or later (no install/build):

```sh
node src/workshop-roster.mjs "$HOME/participants-private.json" 20
OPEN_WORKPLACE_PARTICIPANTS_FILE="$HOME/participants-private.json" node src/workshop.mjs
```

The roster generator refuses to overwrite an existing file, uses random 256-bit access codes, writes with mode `0600`, and never prints credentials. Keep that file outside git. Each roster entry has `id`, `name` and `token`; give each attendee **only their own** token as their workshop access code. You can replace the default participant names with display names before starting. IDs and tokens must remain unique. Never distribute the whole roster or put access codes in a URL.

Open `http://127.0.0.1:3990`, sign in with the access code, and choose an app. The browser uses an HTTP-only session cookie; the original fixed fixture tokens are not participant credentials and are rejected by the gateway.

## Hosted deployment

Publish **only this gateway**, not the three old raw services. For a Node host:

```sh
HOST=0.0.0.0 PORT=3990 PUBLIC_URL=https://workshop.example.com OPEN_WORKPLACE_PARTICIPANTS_FILE=/run/secrets/participants.json node src/workshop.mjs
```

`OPEN_WORKPLACE_PARTICIPANTS` may alternatively contain the private roster JSON in the hosting provider's secret environment configuration. Do not put it in a committed manifest or build argument. `PUBLIC_URL` must be the actual HTTPS origin. The gateway uses its configured origin, not untrusted forwarded headers. Terminate TLS at your trusted platform proxy.

A container build from this package directory is available:

```sh
docker build -f Dockerfile.workshop -t open-workplace-workshop .
```

Mount the roster read-only, supply `PUBLIC_URL` and `OPEN_WORKPLACE_PARTICIPANTS_FILE`, and publish port 3990 only. Children bind ephemeral **loopback-only** ports. Do not add public forwarding to those ports. Shut down or restrict the earlier standalone demo deployments; this gateway cannot secure a separate public URL that bypasses it.

Use `/health` as the gateway liveness check; it does not prewarm or guarantee every participant's child process. Backends start lazily on the first authenticated service request. Preflight each participant before the workshop if startup latency matters.

## Connect from OpenWork

Use a distinct OpenWork member account and browser profile per participant. All attendees may use the same connector URLs:

| Connector | URL |
|---|---|
| Outlook | `https://workshop.example.com/outlook/mcp` |
| Calendar | `https://workshop.example.com/calendar/mcp` |
| Drive | `https://workshop.example.com/drive/mcp` |
| Jira | `https://workshop.example.com/jira/mcp` |
| Confluence | `https://workshop.example.com/confluence/mcp` |

Choose OAuth. The gateway provides authorization-server and protected-resource metadata, dynamic client registration and authorization-code exchange with mandatory S256 PKCE. Sign in with the attendee's access code and approve the connector. The attendee, not a query parameter or a claimed user header, selects the data boundary.

A bearer token can alternatively authenticate direct API/MCP calls using the attendee's access code. Do not configure a shared organization-owned token for all participants: that intentionally authenticates them as the same participant. Register/connect these as per-member credentials. OAuth here does not prove full OpenWork Connect compatibility until that real hosted client flow has been tested.

The gateway deliberately has no ambiguous combined `/mcp` endpoint. Use the five scoped endpoints above.

## What is separated

- Mail, drafts, folders, calendar events, files and upload sessions.
- Jira issues, Confluence pages, comments and audit history.
- The browser UI, REST API and MCP tools all route through the same authenticated participant boundary.
- Identical seeded item IDs do not grant access to another participant. A copied item link opens the recipient's own sandbox or returns not found; it is not a sharing link.
- **Reset my sample data** stops and discards only that participant's private stack. Other attendees continue working. Active operations must finish before resetting.
- Unknown/fixed tokens, unauthenticated APIs/downloads/previews, foreign-origin requests and raw `/state`/`/reset` paths are refused. Own-state inspection is available only when authenticated at `/_workshop/state/microsoft` and `/_workshop/state/atlassian` for verification.

Drive upload URLs remain limited preauthorized capabilities, like the fixture's Graph contract: a random gateway token maps to exactly one participant's pending file upload, allows only PUT, expires after 15 minutes, and is consumed on success. It cannot read files or select another participant. Treat upload URLs as secrets; do not log or share them. Supplying a different participant's bearer/cookie identity is refused. Downloads/previews always require normal participant authentication.

## Limits and recovery

- All data, browser sessions, OAuth registrations/codes/tokens and upload capabilities are in memory. Restarting the gateway loses all changes and requires reconnecting. There is no persistent storage or guaranteed uptime.
- This is data separation between fictional workshop participants, **not an OS/container security boundary for hostile code**. Participants do not get shell/process access. All stacks share host capacity.
- Three Node processes run per active attendee. A roster is bounded to 100 participants, but that is a configuration ceiling, not a demonstrated load capacity. Measure memory/CPU for the actual attendance and hosting plan; the default lightweight hosting tier is not automatically sufficient.
- Each participant has at most 16 concurrent proxied operations. Microsoft files retain the fixture's 10 MiB request/file and 60 MiB per-participant file quota. Proxy response bodies are capped at 16 MiB.
- A failed child makes the sandbox unavailable rather than silently replacing data. The participant can explicitly reset to recover. The gateway stops private children on shutdown.
- Access codes are possession credentials, not proof of a person's email identity. Share privately. Remove or rotate an entry and restart to revoke it and all sessions (this also discards all workshop changes).
- This does not isolate or change OpenWork's own organization sharing, inference quotas, skills, workflows or conversations. Use the intended per-member connection policy there too.

## Verify

```sh
node --test src/workshop-auth.test.mjs src/workshop.test.mjs src/workshop-ui.test.mjs
```

The UI proof uses installed headless Chrome (`CHROME_BIN` overrides the executable). Set `OPEN_WORKPLACE_SCREENSHOT_DIR` to a private output directory to retain screenshots; no screenshot files belong in source control. The tests use generated credentials, not real accounts. Local pass results prove only the paths exercised locally, not deployed TLS, provider quotas or the hosted OpenWork OAuth client.
