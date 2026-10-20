import assert from "node:assert/strict"
import { test } from "node:test"
import {
  FEATURE_KEYS,
  FEATURES,
  featureKeySchema,
  featureLockEnvName,
  mapFeatures,
  parseFeatureEnvironment,
  resolveFeature,
  resolveFeatures,
  RETIRED_FEATURE_KEYS,
  type FeatureContext,
} from "@openwork/features"

const base: FeatureContext = { deployment: "cloud", locks: {}, rollouts: {}, overrides: {} }

test("without stored state, every feature follows its registry default", () => {
  for (const key of FEATURE_KEYS) {
    const resolved = resolveFeature(key, base)
    assert.equal(resolved.enabled, FEATURES[key].default)
    assert.equal(resolved.source, "everyone")
    assert.equal(resolved.overrideApplies, true)
  }
})

test("precedence: unavailable, kill switch, lock, override, everyone", () => {
  const key = "secureSecretFields"
  assert.equal(resolveFeature(key, { ...base, rollouts: { [key]: { enabled: true, killed: false } } }).enabled, true)
  const overridden = resolveFeature(key, { ...base, overrides: { [key]: true } })
  assert.equal(overridden.enabled, true)
  assert.equal(overridden.source, "override")
  assert.equal(resolveFeature(key, { ...base, overrides: { [key]: true }, locks: { [key]: false } }).enabled, false)
  const killed = resolveFeature(key, { ...base, overrides: { [key]: true }, locks: { [key]: true }, rollouts: { [key]: { enabled: true, killed: true } } })
  assert.equal(killed.enabled, false)
  assert.equal(killed.source, "killed")
  assert.equal(killed.overrideApplies, false)
})

test("an organization override can turn a feature off while it is on for everyone", () => {
  const key = "remoteSessionEvents"
  const resolved = resolveFeature(key, { ...base, rollouts: { [key]: { enabled: true, killed: false } }, overrides: { [key]: false } })
  assert.equal(resolved.everyone, true)
  assert.equal(resolved.enabled, false)
})

test("mapFeatures and the key schema cover exactly the registry", () => {
  assert.deepEqual(Object.keys(mapFeatures(() => 0)).sort(), [...FEATURE_KEYS].sort())
  for (const key of FEATURE_KEYS) assert.equal(featureKeySchema.parse(key), key)
  assert.equal(featureKeySchema.safeParse("notAFeature").success, false)
  assert.equal(featureKeySchema.safeParse("appMcpServers").success, false)
  for (const key of RETIRED_FEATURE_KEYS) assert.equal(featureKeySchema.safeParse(key).success, false, `${key} is retired`)
  assert.deepEqual(Object.keys(resolveFeatures(base)).sort(), [...FEATURE_KEYS].sort())
})

test("managed deployments stays opt-in and cloud-only after folding GCP and agent tools", () => {
  assert.equal(resolveFeature("managedDeployments", base).enabled, false)
  const selfHosted = resolveFeature("managedDeployments", {
    ...base,
    deployment: "self_hosted",
    locks: { managedDeployments: true },
    overrides: { managedDeployments: true },
    rollouts: { managedDeployments: { enabled: true, killed: false } },
  })
  assert.equal(selfHosted.enabled, false)
  assert.equal(selfHosted.source, "unavailable")
  assert.equal(featureKeySchema.safeParse("managedDeploymentsGcp").success, false)
  assert.equal(featureKeySchema.safeParse("managedDeploymentsMcp").success, false)
  const legacyLocks = parseFeatureEnvironment({
    DEN_DEPLOYMENT: "cloud",
    DEN_FEATURE_MANAGED_DEPLOYMENTS_GCP: "true",
    DEN_FEATURE_MANAGED_DEPLOYMENTS_MCP: "true",
  })
  assert.deepEqual(legacyLocks.locks, {})
  assert.equal(resolveFeature("managedDeployments", { ...base, locks: legacyLocks.locks }).enabled, false)
})

test("retired GA locks cannot disable models, skills, permissions or team membership caching", () => {
  const parsed = parseFeatureEnvironment({
    DEN_FEATURE_ORG_DEFAULT_MODEL: "false",
    DEN_FEATURE_MODEL_REMOVAL_RECOVERY: "false",
    DEN_FEATURE_LAST_TURN_MODEL_FOOTER: "false",
    DEN_FEATURE_NATIVE_CLOUD_SKILLS: "false",
    DEN_FEATURE_MCP_SKILLS_EXTENSION: "false",
    DEN_FEATURE_PERMISSIONS: "false",
    DEN_FEATURE_TEAM_MEMBERSHIP_CACHE: "false",
  })
  assert.equal(parsed.deployment, "self_hosted")
  assert.deepEqual(parsed.locks, {})
  assert.equal(parsed.problems.length, 7)
  assert.ok(parsed.problems.every((problem) => !problem.fatal && problem.message.includes("ignored")))
})

test("service readiness is retired: no key, and an old operator lock is ignored with a warning", () => {
  assert.equal(featureKeySchema.safeParse("serviceReadiness").success, false)
  const parsed = parseFeatureEnvironment({ DEN_FEATURE_SERVICE_READINESS: "false" })
  assert.deepEqual(parsed.locks, {})
  assert.equal(parsed.problems.length, 1)
  assert.ok(parsed.problems.every((problem) => !problem.fatal && problem.message.includes("ignored")))
})

test("every key maps to a unique DEN_FEATURE_ name", () => {
  const names = FEATURE_KEYS.map(featureLockEnvName)
  for (const name of names) assert.match(name, /^DEN_FEATURE_[A-Z0-9]+(?:_[A-Z0-9]+)*$/)
  assert.equal(new Set(names).size, names.length)
  assert.equal(featureLockEnvName("remoteSessionEvents"), "DEN_FEATURE_REMOTE_SESSION_EVENTS")
})

test("environment: self_hosted by default, strict values, unknown keys warn", () => {
  const empty = parseFeatureEnvironment({})
  assert.equal(empty.deployment, "self_hosted")
  assert.deepEqual(empty.locks, {})
  assert.deepEqual(empty.problems, [])

  const parsed = parseFeatureEnvironment({
    DEN_DEPLOYMENT: "cloud",
    DEN_FEATURE_REMOTE_SESSION_EVENTS: "true",
    DEN_FEATURE_SECURE_SECRET_FIELDS: "false",
    DEN_FEATURE_WORKBOT: "false",
    DEN_FEATURE_PERMISSIONS: "false",
    DEN_FEATURE_ORG_MANAGED_DASHBOARDS: "",
    DEN_FEATURE_NOT_A_THING: "true",
  })
  assert.equal(parsed.deployment, "cloud")
  assert.deepEqual(parsed.locks, { remoteSessionEvents: true, secureSecretFields: false })
  assert.deepEqual(parsed.problems.map((problem) => [problem.variable, problem.fatal]), [["DEN_FEATURE_WORKBOT", false], ["DEN_FEATURE_PERMISSIONS", false], ["DEN_FEATURE_NOT_A_THING", false]])

  const fatal = parseFeatureEnvironment({ DEN_DEPLOYMENT: "prod", DEN_FEATURE_REMOTE_SESSION_EVENTS: "yes" })
  assert.deepEqual(fatal.problems.map((problem) => [problem.variable, problem.fatal]), [["DEN_DEPLOYMENT", true], ["DEN_FEATURE_REMOTE_SESSION_EVENTS", true]])
})
