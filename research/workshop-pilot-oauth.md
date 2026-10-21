# Workshop pilot: OAuth, guest isolation and reset

## Status / safe scope

Source inspection + **9 pure mocked Node tests** only. No infrastructure allocated,
no Render/production calls, no credentials read, no app launched locally, no live
Daytona verdict claimed. Existing integration files are unchanged. Helpers attach
to/probe an **already running** world only; browser consent remains a real click.

## High-risk blockers to relay before the pilot

1. **Path/query preview URLs are currently unsupported, deliberately.**
   `worlds/lib/workshop-gateway.ts:100–108` rejects a signed preview with any
   non-root path/query/hash; `workshop.mjs:77` rejects it as PUBLIC_URL;
   `workshop-auth.mjs:25–26,132–136` requires an exact origin and exact app audience.
   Existing test `worlds/lib/workshop.test.ts:116–120` explicitly rejects
   `/?token=…`. Therefore do **not** fix this by `.origin`-stripping a credential,
   appending `/drive/mcp` after a query, or relaxing only the parser. A URL whose
   authentication lives in its path/query needs a verified canonical port-bound
   signed hostname (supported by the existing private-preview contract), or a
   separately designed proxy/bootstrap flow that proves unauthenticated Den
   requests can reach the canonical origin. No such bootstrap is implemented in
   the workshop source. Stop the pilot if only a path/query preview is available.

2. **Health with a bypass header is not OAuth readiness.** Gateway probes send
   `x-daytona-skip-preview-warning: true` (`workshop-gateway.ts:37,208,222,226`).
   No matching header was found in Den source. Den's discovery/registration/token
   requests do not inherit a human browser's warning cookie. Run the new plain
   AND bypass preflight from the runner **and inside the existing Den sandbox**.
   If only bypass passes, fix preview routing/Den transport in the lead branch;
   accepting the warning in the attendee browser cannot fix server-to-server
   OAuth. The helper also checks HTML entry redirects, but only the real browser
   can prove the actual warning experience and POST/callback behavior.

3. **Never refresh signed aliases after configuration.**
   `evals/packages/hosts/src/provision.ts:1159–1167` documents that each preview
   generation signs a different hostname. Gateway PUBLIC_URL, five connection
   URLs, protected resources, authorization-server issuer and browser host must
   all use the *same saved* URL. Den web/API also have baked identity URLs. A new
   alias is not an equivalent OAuth issuer. Auth persistence is bound to the old
   origin (`workshop-auth.mjs:46`), so restarting on a new origin with the old
   auth database fails closed; do not delete auth state merely to hide this.

4. **Guest identity belongs to a browser profile, NOT a Den member.**
   Use the same actual external browser profile for all five consents. Incognito
   windows sharing one incognito profile are not two people. Desktop webview and
   external Chrome may have different cookie jars; inspect the OAuth target and
   run data probes in that target's profile. B requires a separate real profile
   (not another tab). Never share/copy workshop cookies between attendees.

5. **Reset does not disconnect; Forget does not revoke.**
   `workshop.mjs:301–311` resets business data only; auth is outside participants
   storage. `workshop-auth.mjs:274` deletes only the browser session on logout.
   Connected applications retain grants after Forget. Do not promise that Forget
   signs the app out, and do not reconsent after reset (that masks regressions).
   Expect HTTP 409 for busy reset, not partial deletion; wait for real in-flight
   work to finish before a deliberate retry, never blindly resubmit a timeout.

## Read-only preflight: exact usage

In this checkout, set `WORKSHOP_PILOT_URL` to the saved **existing gateway** URL
from the pilot's outputs, without printing that URL into evidence:

```sh
node worlds/lib/workshop-pilot-oauth.mjs
node --test evals/proofs/workshop-pilot-oauth.test.mjs
```

The CLI reads `WORKSHOP_PILOT_URL` from its environment, accepts HTTPS origins
only, creates no guests/grants, sends no cookies/tokens, follows no redirects,
and checks all five resources/challenges + public S256 metadata with and without
warning bypass. A successful receipt has 10 checks. It is NOT a consent proof.
The lead can copy this dependency-free file into its **existing Den sandbox**
and run the same command there with the saved URL; do not create another sandbox.

## One traversed browser path (then repeat per attendee)

Use supported CDP/browser tools against the **existing Daytona browser**. List
pages first, observe the actual target and use its explicit page ID. Do not use
the generic `cdp.mjs` auto-target shortcut for OAuth: that script prefers the
OpenWork renderer over the external consent tab. Never target a local browser.

1. Open the saved Den web URL in attendee A's external browser profile. Sign in
   with that world's disposable attendee account through the real UI if needed.
   A desktop bearer session alone is not necessarily a Den browser cookie:
   `evals/worlds/workshop-oauth.ts:64–80` explicitly distinguishes these.
   Use the world's existing five `links.signIn` addresses / displayed Sign in
   controls, **not** newly created connections. Labels from the world are
   `Workshop Outlook`, `Workshop Calendar`, `Workshop Drive`, `Workshop Jira`,
   `Workshop Confluence` (`connectionName` capitalizes them).
2. Verify five per-member connections are initially disconnected. For each app,
   open its real Den sign-in page, then click the page's Sign in button. Do not
   manufacture an `/oauth/authorize` URL or POST consent with fetch.
3. On the actual workshop page require **Allow workplace access**, no password
   field, and a `Workshop guest N` label. Expand **Connection details**; the
   Resource must equal `SAVED_GATEWAY/<app>/mcp`, scope `workplace`. Record the
   same label across all five; inspect URL parameters without retaining code,
   state, client ID or challenge. A GET must leave the connection disconnected.
4. Click **Allow workplace access** once. Observe return to the saved Den site
   and the correct connection Ready/connected-for-me. Check authenticated tool
   discovery for that member/connection (not just an org-visible connection row).
   Repeat all five, always returning through Den between grants: this exercises
   actual cross-origin navigation/cookie delivery. Do not call it cross-site
   solely because hostnames differ: signed previews may share a registrable
   domain; inspect actual `Sec-Fetch-Site` if claiming SameSite cross-site
   coverage. The existing proof's different-host assertion does not establish
   different sites. Capture first consent and all-five-ready screenshots, with
   no OAuth callback query in frame.
5. In A's **same profile**, open saved gateway `/` and verify the same guest.
   Run browser helper `snapshot`, retaining only its small identity/hash receipt.
   Call this A0. Use a second existing isolated browser profile B; open gateway
   `/`, verify a different guest and take B0. No second desktop/backend is needed.
6. Run `mark` once in A (writes five fictional services, no mail sends); record
   A1 snapshot and returned file ID. Both hashes must differ from A0. In B run
   `find`: false; snapshot must equal B0. Use the returned A file ID in B's
   same-origin `/v1.0/me/drive/items/<id>` GET: expect 404 and no A content. In A
   expect 200. A filename absent in B alone is weaker than this ID-based denial.
7. For a positive unaffected-peer witness, run `mark` in B with a different safe
   marker, e.g. `workshop-pilot-peer`, then retain B1 snapshot.
8. In A navigate to `/_workshop/reset`. **GET is confirmation only**: take
   another snapshot and require A1, not A0. Click the real **Reset my sample
   data** button. After the 303 back to `/`, snapshot must equal A0 (same guest,
   mail and both hashes), A's `find` false; B snapshot still B1 and its own
   marker still present. Do not use operator reset-all for this isolation test.
9. Without reconsenting, verify all five Den connections still Ready and invoke
   a harmless read tool through each saved connection (discover exact names/
   schemas first). A's Drive read/search must no longer find the marker. This
   separates REST reset coverage from OAuth-grant continuity coverage.
10. Optional final destructive identity check: A's `/_workshop/leave` GET must
    not change identity; click **Forget this browser’s workspace**, see signed-out
    page, click **Open a new private workspace**, observe a new guest. Existing
    Den grants still identify the OLD guest until revoked/expired: expected,
    not an isolation failure. Do this only after the successful pilot evidence.

For strict *Den per-member* isolation, repeat steps 1–4 as a second disposable
Den member in profile B; check B stays disconnected after each A grant, and use
A/B member-scoped connector calls for file isolation. With only one attendee,
steps 5–8 prove gateway/profile isolation, **not** two Den-member grant isolation.
The existing proof `evals/proofs/workshop-oauth.proof.test.ts:39–130` is the
reference for real five-consent/per-member MCP assertions; running that world
would allocate more infrastructure, so do NOT launch it during this one-world pilot.

## Browser helper: exact evaluation expressions

`worlds/lib/workshop-pilot-oauth-browser.mjs` exports a self-contained function.
Generate an expression, then pass its stdout as the expression/body to the
supported CDP evaluator for the selected **workshop-origin** page. For a tool
expecting a function, wrap it as `async () => await <expression>`.

```sh
node --input-type=module -e 'import {browserProbe} from "./worlds/lib/workshop-pilot-oauth-browser.mjs"; console.log(`(${browserProbe.toString()})("snapshot")`)'
node --input-type=module -e 'import {browserProbe} from "./worlds/lib/workshop-pilot-oauth-browser.mjs"; console.log(`(${browserProbe.toString()})("mark", "workshop-pilot-private")`)'
node --input-type=module -e 'import {browserProbe} from "./worlds/lib/workshop-pilot-oauth-browser.mjs"; console.log(`(${browserProbe.toString()})("find", "workshop-pilot-private")`)'
```

Helpers use same-origin browser cookies naturally, never extract them, never mint
OAuth tokens, never click consent and never reset automatically. `mark` is an
explicit fictional-data mutation across five services; do not rerun an uncertain
outcome automatically. Hashes cover the two actual state endpoints that contain
all five services, with canonical object-key ordering; compare receipts exactly.
Use a fresh pilot marker per attempt and capture A0 before any helper mutations.
Run snapshots with no background agent/tool activity to avoid changing the audit.

## Validation / handoff

`node --test evals/proofs/workshop-pilot-oauth.test.mjs`: 9/9 passing with mocked
fetch + isolated JS context, no network/listeners. Covers URL refusal/redaction,
plain-warning failure, all five resource checks, issuer mismatch, HTML warning,
transport redaction, serialization, read-only digest receipts and five marker
writes. Live consent, Den exchange, filesystem persistence and reset traversal
are explicitly left to the lead's existing Daytona pilot. No push performed.
