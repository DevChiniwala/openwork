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
  const key = "liveProviderSync"
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
  const key = "liveProviderSync"
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

test("automatic v2 migration has no feature key and ignores legacy opt-out locks", () => {
  for (const key of ["engineV2Upgrade", "engineV2ForceUpgrade"]) {
    assert.equal(featureKeySchema.safeParse(key).success, false)
    assert.equal(Object.hasOwn(resolveFeatures(base), key), false)
  }
  const parsed = parseFeatureEnvironment({
    DEN_FEATURE_ENGINE_V2_UPGRADE: "false",
    DEN_FEATURE_ENGINE_V2_FORCE_UPGRADE: "false",
  })
  assert.deepEqual(parsed.locks, {})
  assert.equal(parsed.problems.length, 2)
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
  assert.equal(featureLockEnvName("liveProviderSync"), "DEN_FEATURE_LIVE_PROVIDER_SYNC")
})

test("environment: self_hosted by default, strict values, unknown keys warn", () => {
  const empty = parseFeatureEnvironment({})
  assert.equal(empty.deployment, "self_hosted")
  assert.deepEqual(empty.locks, {})
  assert.deepEqual(empty.problems, [])

  const parsed = parseFeatureEnvironment({
    DEN_DEPLOYMENT: "cloud",
    DEN_FEATURE_WORKBOT_DOCUMENTS: "true",
    DEN_FEATURE_LIVE_PROVIDER_SYNC: "false",
    DEN_FEATURE_WORKBOT: "false",
    DEN_FEATURE_PERMISSIONS: "false",
    DEN_FEATURE_ORG_MANAGED_DASHBOARDS: "",
    DEN_FEATURE_NOT_A_THING: "true",
  })
  assert.equal(parsed.deployment, "cloud")
  assert.deepEqual(parsed.locks, { workbotDocuments: true, liveProviderSync: false })
  assert.deepEqual(parsed.problems.map((problem) => [problem.variable, problem.fatal]), [["DEN_FEATURE_WORKBOT", false], ["DEN_FEATURE_PERMISSIONS", false], ["DEN_FEATURE_NOT_A_THING", false]])

  const fatal = parseFeatureEnvironment({ DEN_DEPLOYMENT: "prod", DEN_FEATURE_LIVE_PROVIDER_SYNC: "yes" })
  assert.deepEqual(fatal.problems.map((problem) => [problem.variable, problem.fatal]), [["DEN_DEPLOYMENT", true], ["DEN_FEATURE_LIVE_PROVIDER_SYNC", true]])
})

test("connection presentation is retired and old operator locks are ignored", () => {
  assert.equal(featureKeySchema.safeParse("offlineRecovery").success, false)
  for (const value of ["true", "false"]) {
    const parsed = parseFeatureEnvironment({ DEN_FEATURE_OFFLINE_RECOVERY: value })
    assert.deepEqual(parsed.locks, {})
    assert.equal(parsed.problems.length, 1)
    assert.ok(parsed.problems.every((problem) => !problem.fatal && problem.message.includes("ignored")))
  }
})

test("fourth pass: graduated, folded and removed keys are retired and their old locks are ignored", () => {
  for (const key of ["cloudAgentGateway", "secureSecretFields", "slackAssistant", "workbotFirstRun", "workbotInlineConnect", "headlessSessionIndex", "workbotGuidedNavigation", "engineV2Upgrade", "headlessStepTurns", "workbotTeamLinks", "remoteSessionEvents", "modelsAnalyticsUi", "taskAnalyticsUi"]) {
    assert.equal(featureKeySchema.safeParse(key).success, false, `${key} is retired`)
  }
  const parsed = parseFeatureEnvironment({ DEN_FEATURE_SLACK_ASSISTANT: "false", DEN_FEATURE_HEADLESS_STEP_TURNS: "true", DEN_FEATURE_REMOTE_SESSION_EVENTS: "true" })
  assert.deepEqual(parsed.locks, {})
  assert.equal(parsed.problems.length, 3)
  assert.ok(parsed.problems.every((problem) => !problem.fatal && problem.message.includes("ignored")))
})


test("retired headless GA locks cannot disable durable turns or session cells", () => {
  const parsed = parseFeatureEnvironment({
    DEN_FEATURE_HEADLESS_DURABLE_TURNS: "false",
    DEN_FEATURE_HEADLESS_SESSION_CELLS: "false",
  })
  assert.deepEqual(parsed.locks, {})
  assert.equal(parsed.problems.length, 2)
  assert.ok(parsed.problems.every((problem) => !problem.fatal && problem.message.includes("ignored")))
  for (const key of ["headlessDurableTurns", "headlessSessionCells"]) {
    assert.equal(featureKeySchema.safeParse(key).success, false)
    assert.equal(Object.hasOwn(resolveFeatures(base), key), false)
  }
})


test("member overrides inherit by default and take priority over organization and everyone", () => {
  const key = "liveProviderSync"
  const context: FeatureContext = { ...base, overrides: { [key]: false }, memberOverrides: { [key]: true } }
  assert.equal(resolveFeature(key, context).enabled, true)
  assert.equal(resolveFeature(key, context).source, "member")
  assert.equal(resolveFeature(key, { ...context, memberOverrides: {} }).enabled, false)
  assert.equal(resolveFeature(key, { ...base, overrides: { [key]: true }, memberOverrides: { [key]: false } }).enabled, false)
  // Other features and organization-only reads are unaffected.
  assert.equal(resolveFeature(key, { ...base, overrides: context.overrides }).enabled, false)
  assert.equal(resolveFeature("managedDeployments", context).enabled, false)
})

test("member overrides cannot bypass deployment restrictions, operator locks or the kill switch", () => {
  const key = "liveProviderSync"
  const context: FeatureContext = { ...base, memberOverrides: { [key]: true } }
  assert.equal(resolveFeature(key, { ...context, locks: { [key]: false } }).source, "lock")
  assert.equal(resolveFeature(key, { ...context, locks: { [key]: false } }).enabled, false)
  assert.equal(resolveFeature(key, { ...context, rollouts: { [key]: { enabled: true, killed: true } } }).enabled, false)
  assert.equal(resolveFeature("managedDeployments", { ...base, deployment: "self_hosted", memberOverrides: { managedDeployments: true } }).enabled, false)
})
