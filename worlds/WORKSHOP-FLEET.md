# Private Daytona workshop fleet

`workshop-fleet` composes one Den/Gateway backend and twenty separate Linux desktop sandboxes. This is an operator-owned, temporary workshop, not a production deployment. It does not implement the Windows login/password-reset exercise.

## Safety and cost

- Each attendee is an ordinary Den member with a unique desktop, Chromium profile, filesystem and fictional workplace guest. Never clone an authenticated profile or share an owner account.
- Five hosted workplace connections use per-member OAuth. The automatic guest identity belongs to the browser profile; attendees sharing a viewer link share that entire workstation. The fictional service now removes attendance/registration quotas in favor of explicit reset controls; use its `WORKSHOP.md` for the deployed reset procedure. Whole-service reset preserves identities and OAuth but does not erase VM files or OpenWork chat history.
- The controller installs the real upstream credential in Den's encrypted provider storage. Attendee environments do not receive that credential or the shared evaluation secrets volume.
- Den starts without demo users and with development email routes disabled. Secrets for authentication, encryption and Gateway webhooks are generated per run. Production-mode cohosting uses the sandbox's actual private interface. A loopback-only SMTP discard sink accepts synthetic `workshop.test` invitations; it does not send real email or expose an HTTP inbox.
- All sandboxes must be provider-confirmed private. Only signed noVNC capabilities appear on individual attendee cards. Do not post the host sheet publicly.
- Current maintained snapshots allocate 4 CPU / 8 GiB / 10 GiB each. Daytona does not accept CPU/memory overrides when creating from a snapshot. Twenty desktops plus one backend estimate about $167 for 24 hours, plus disk, against the approved $180 infrastructure ceiling. Check current prices and quota again for a future event.
- Each of twenty members receives a hard $5 weekly estimated usage policy. This is settled-spend admission, not prepaid money or an exact invoice ceiling: in-flight requests can overshoot. The recipe rejects an event crossing the Monday 05:00 UTC reset.
- Provider TTL and controller teardown end the event. TTL starts at creation; startup consumes some of the requested availability. Guest cookies can outlive OAuth grants; the hosted workplace currently requires renewed consent after its eight-hour authorization lifetime.

## Launch

Use Node 24 and the team's scoped Daytona identity. Fetch secrets into the controller environment only; never persist them in this repository. `OPENWORK_EVAL_REF` must match `--ref`, because the world CLI otherwise resolves its own default source.

```sh
export OPENWORK_EVAL_REF=<reviewed-full-pushed-sha>
pnpm world plan workshop-fleet --place daytona --stage workshop-event
pnpm world up workshop-fleet --place daytona --os linux --stage workshop-event --detach --timeout 3600000 -- \
  --count 20 --lifetime 1440 --ref "$OPENWORK_EVAL_REF" \
  --output-dir <absolute-private-directory-outside-git>
```

The controller also requires `DAYTONA_API_URL`, `DAYTONA_API_KEY`, and `OPENAI_API_KEY` in its environment. Use the `daytona` and `get-env-var` skills for scoped retrieval. The output directory must be caller-owned mode 0700. Files are mode 0600 and are never silently overwritten.

Default `--count 1` provisions a single pilot desktop against the same twenty-member budget configuration. For a complete fleet, use `--count 20`: the first desktop must pass real OAuth, browser-profile handoff, private noVNC and paid model/tool proof before the remaining nineteen start, with at most five workers. This does not increase the fleet size: twenty 4-CPU/8-GiB desktops plus one backend stay within the checked team quota. The pilot remains outside that worker pool.

Each individual HTML card is written after its seat passes; the host sheet is written only after the entire requested fleet passes. Do not distribute partial-run cards: a later failure tears down the owned fleet. Distribute each attendee's own card, not the controller receipt, backend URL, CDP URL, host sheet, or another attendee's viewer link.

```sh
pnpm world outputs workshop-fleet --stage workshop-event --json
pnpm world down workshop-fleet --stage workshop-event
```

Do not extend the lifetime or spend allowance without renewed approval. Failed startup is not a ready workshop: inspect the redacted private failure log and screenshots before retrying, and verify owned resources were cleaned up.

## Per-seat recovery and whole-workshop proof

The recipe disables idle screen blanking/locking only inside its owned ephemeral workshop desktops. Signed noVNC links explicitly permit interactive input. This is not a Windows password-reset exercise and does not disable locking on the controller or a developer machine.

Use Node 24 and the scoped operator Daytona environment. Commands validate the selected manifest seat against the provider's private organization and workshop name; there is no all-account target. They do not extend TTL or change allowances.

```sh
node worlds/workshop-fleetctl.ts <private-output>/host-sheet.json attendee01 status
node worlds/workshop-fleetctl.ts <private-output>/host-sheet.json attendee01 open
node worlds/workshop-fleetctl.ts <private-output>/host-sheet.json attendee01 stop-turn
node worlds/workshop-fleetctl.ts <private-output>/host-sheet.json attendee01 unlock
node worlds/workshop-fleetctl.ts <private-output>/host-sheet.json attendee01 reset-sample-data --confirm-personal-reset=attendee01
```

`open` returns only the local private card path. `stop-turn` uses the actual focused app's Stop action; it fails rather than silently targeting another session. `unlock` resets X11 activity and disables the owned session's idle locker without guessing passwords. Personal reset uses that seat's existing authenticated browser confirmation, preserves its OAuth identity, and never calls the service-wide reset endpoint. Reset only when the attendee explicitly agrees.

Once attendee01 and attendee02 are fully verified, run the paid representative workflow against those **existing** VM IDs (not new infrastructure):

```sh
node worlds/workshop-proof.ts <owned-attendee01-id> <owned-attendee02-id> <private-output>/business-proof
```

It proves real signed-RFB keyboard input and stopping one running turn, then actual model/tool work: a downloaded one-slide PPTX and unsent existing-thread reply, ordinary engineering Jira Task and preserving Confluence append, existing calendar reschedule and honest missing-policy answer, cross-attendee isolation, personal reset, and another real OAuth-backed read. All reports/screenshots/downloads stay private outside Git. It consumes the existing members' $5 allowances; it never raises them. A failing assertion is incomplete evidence, not a ready workshop.

The driver runs from the current checkout; VM application code is the exact pushed `--ref`. Record both versions when reporting a cold run, and measure elapsed time from the user's requested start—not the last retry. Each private seat control receipt records `startedAt` and `readyAt`.

## Local checks (no infrastructure or model charges)

```sh
node --test worlds/workshop-fleet.test.ts worlds/workshop-ops.test.ts worlds/lib/workshop-setup.test.ts worlds/lib/workshop-redaction.test.ts
pnpm --dir evals exec vitest run packages/hosts/src/provision-options.test.ts packages/hosts/src/daytona-options.test.ts packages/hosts/src/local-chrome.test.ts packages/hosts/src/browser.test.ts
```
