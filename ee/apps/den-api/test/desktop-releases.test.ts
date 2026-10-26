import assert from "node:assert/strict"
import { test } from "node:test"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/exp_dvg_unit"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-desktop-version-unit-test-secret-not-production"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-desktop-version-unit-test-key-not-production"
process.env.OPENWORK_DEV_MODE = "1"
const { env } = await import("../src/env.js")
const { capDesktopReleaseMetadata, createDesktopReleaseSource } = await import("../src/desktop-releases.js")
const metadata = { minAppVersion: "0.17.0", latestAppVersion: "0.18.62", publishedDesktopVersions: ["0.18.62", "0.18.60", "0.18.59", "0.18.58"] }

test("self-hosted metadata caps both old-client fields without changing its source inventory", () => {
  env.features.deployment = "self_hosted"
  env.serviceVersion = "0.18.59"
  assert.deepEqual(capDesktopReleaseMetadata(metadata), {
    minAppVersion: "0.17.0", latestAppVersion: "0.18.59", maxDesktopVersion: "0.18.59", publishedDesktopVersions: ["0.18.59", "0.18.58"],
  })
  assert.equal(metadata.publishedDesktopVersions.length, 4)
  env.serviceVersion = "0.18.70"
  assert.equal(capDesktopReleaseMetadata(metadata).latestAppVersion, "0.18.62", "never invent an unpublished upgrade")
})

test("hosted Cloud and untagged development deployments keep their release range", () => {
  env.features.deployment = "cloud"
  env.serviceVersion = "0.18.59"
  assert.deepEqual(capDesktopReleaseMetadata(metadata), { ...metadata, maxDesktopVersion: null })
  env.features.deployment = "self_hosted"
  for (const version of ["dev", "abcdef0", "0.18.60-alpha.1"]) {
    env.serviceVersion = version
    assert.deepEqual(capDesktopReleaseMetadata(metadata), { ...metadata, maxDesktopVersion: null })
  }
})

test("static and cached GitHub metadata both pass through the self-hosted cap", async () => {
  env.features.deployment = "self_hosted"
  env.serviceVersion = "0.18.59"
  const previousFetch = globalThis.fetch
  const previousMode = env.desktopReleasesMode
  try {
    env.desktopReleasesMode = "github"
    let fetches = 0
    globalThis.fetch = async () => {
      fetches++
      return Response.json(metadata.publishedDesktopVersions.map(version => ({ tag_name: `v${version}`, draft: false, prerelease: false })))
    }
    const source = createDesktopReleaseSource()
    assert.equal((await source.getDesktopReleaseMetadata()).latestAppVersion, "0.18.59")
    assert.equal((await source.getDesktopReleaseMetadata()).latestAppVersion, "0.18.59")
    assert.equal(fetches, 1)
    env.desktopReleasesMode = "static"
    const result = await source.getDesktopReleaseMetadata()
    assert.equal(result.maxDesktopVersion, "0.18.59")
    assert.ok(result.publishedDesktopVersions.every(version => !["0.18.60", "0.18.61", "0.18.62"].includes(version)))
  } finally {
    globalThis.fetch = previousFetch
    env.desktopReleasesMode = previousMode
  }
})
