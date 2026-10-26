import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, startFakeHttpServer, strings } from "./harness.js"

const releases = await startFakeHttpServer((_request, _body, response) => {
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(["0.18.62", "0.18.60", "0.18.59", "0.18.58"].map(version => ({
    tag_name: `v${version}`, draft: false, prerelease: false,
  }))))
})
const den = await bootDen({ env: {
  DEN_ORG_MODE: "single_org", DEN_DEPLOYMENT: "self_hosted", DEN_API_VERSION: "0.18.59",
  DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP: "true", DEN_DESKTOP_RELEASES_MODE: "github",
  DEN_DESKTOP_RELEASES_BASE_URL: releases.url,
} })
// This public-only test finishes before Better Auth's asynchronous registry
// bootstrap otherwise does; settle it before dropping the disposable database.
const { auth } = await import("../../src/auth.js")
await auth.$context
after(async () => { await den.close(); await releases.close() })

test("a client on an older self-hosted Den receives no newer release, without needing an org allowlist", async () => {
  const result = await den.request(null, "GET", "/v1/app-version")
  assert.equal(result.status, 200)
  assert.equal(field(result.body, "latestAppVersion"), "0.18.59")
  assert.equal(field(result.body, "maxDesktopVersion"), "0.18.59")
  assert.deepEqual(strings(field(result.body, "publishedDesktopVersions")), ["0.18.59", "0.18.58"])
  // Old clients consume latestAppVersion and publishedDesktopVersions; no new
  // field, bearer, or organization rollout is required to get the safety cap.
  const again = await den.request(null, "GET", "/v1/app-version")
  assert.deepEqual(again.body, result.body)
})
