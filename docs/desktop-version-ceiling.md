# Desktop updates on self-hosted Den

A stable self-hosted Den release is the maximum desktop release offered by
the normal update flow. Compare the full release version, not just its minor:
Den `0.18.59` must not approve desktop `0.18.60` or `0.18.62`. This is a
conservative rollout boundary, not a claim that every older desktop is API
compatible. The existing minimum desktop version still applies. There is no
new LTS branch or promise to maintain old releases: upgrade Den and desktops
to the latest release for fixes.

## Options considered

### Default organization allowlist

Have Den synthesize an allowlist from its own release when none is configured.
Old stable clients already understand that field. A one-element list would
also prevent upgrading an older desktop through an earlier compatible release,
and would conflate the operator's explicit policy with the deployment maximum.
It would not protect a new desktop talking to an unpatched Den.

### Desktop-only ceiling

Have the desktop discover Den's deployment and health version before approving
an update. This protects new desktops even on older Den. It cannot fix the
already-installed desktop population until those clients are upgraded, and
must not infer hosted Cloud from a hostname.

### Cap Den metadata, with a desktop compatibility reader (selected)

Cap the existing latest-version and published-inventory fields at the stable
self-hosted service version, and advertise `maxDesktopVersion`. Old stable
clients immediately consume the capped fields. New clients derive the same
ceiling from `/v1/features` and `/health` only when the field is absent.

## Contract and boundaries

- `DEN_DEPLOYMENT=self_hosted` applies the ceiling regardless of organization
  mode. Hosted Cloud (`cloud`) keeps its existing release range and alpha
  behavior. Non-stable development/commit service versions have no stable
  release ceiling.
- Both GitHub-discovered metadata and static/failure fallback metadata are
  capped. The binary feed is unchanged. Install-tag overrides do not lift the
  updater ceiling; an organization allowlist can narrow it, not lift it.
- A new desktop on an older Den reads the public deployment classification
  and the actual service health version. Failure to establish the policy
  blocks update approval; no hostname heuristic or authentication workaround.
  The compatibility reader can be removed once the minimum supported Den
  advertises `maxDesktopVersion`.
- A desktop already newer than Den is **not downgraded**, signed out, or
  rolled back to the old engine. It can keep running, but the normal updater
  must not advance it further beyond the ceiling. Update Den to restore the
  supported rollout order; an older-version installer is not a data rollback.
- New desktops apply the explicit ceiling before the alpha one-patch grace
  and before the already-installed-prerelease exception. Old alpha clients
  retain their historical grace rules: operators needing a strict ceiling
  on those clients must disable alpha through `allowAlphaUpdates` until the
  desktops receive this change. Old stable clients need only the Den change.
- This does not revoke a native update already staged before the policy was
  fetched. Such an update can still install on quit in an old client. Apply
  policy before downloads are staged; do not promise that editing an allowlist
  cancels a staged native update. Manual installers are outside the gate.
- No new flag: this is a bug fix / derived deployment configuration, exempt
  under `.opencode/skills/add-a-feature` rather than a new product rollout.

## Check it

1. Run a stable self-hosted Den with a public release newer than its own
   version available upstream, and leave the organization allowlist unset.
2. `GET /v1/app-version` must report `maxDesktopVersion` equal to the service
   version; neither latest nor inventory may exceed it. An old stable desktop
   at that version must have no installable newer update.
3. Repeat with an allowlist containing a newer public release: it must not
   raise the ceiling. Repeat with hosted Cloud: its inventory remains intact.
4. On a new desktop with an older Den, check `/v1/features` + `/health`
   discovery. A failed discovery must not approve an update. Repeat with an
   already-newer desktop and an alpha candidate: no forced downgrade and no
   further update beyond the self-hosted ceiling.

Coverage is colocated in `ee/apps/den-api/test/desktop-releases.test.ts`,
`ee/apps/den-api/test/api/desktop-version-ceiling.api.test.ts`,
`apps/app/tests/den-desktop-version-ceiling.test.ts`, and
`apps/app/tests/version-gate.test.ts`.
