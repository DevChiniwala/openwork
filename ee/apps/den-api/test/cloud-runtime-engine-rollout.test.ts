import assert from "node:assert/strict"
import { test } from "node:test"
import { renderOpenWorkBootstrapScript, type OpenWorkBootstrapConfig } from "@openwork-ee/cloud-runtime/bootstrap"
import { createCloudRuntimeOrchestrator, type CloudRuntimeOrchestratorConfig } from "@openwork-ee/cloud-runtime/orchestrator"
import { createInMemoryRuntimeInstanceStore } from "@openwork-ee/cloud-runtime/testing"
import { createFakeProvider } from "@openwork/sandbox/testing"

const bootstrap: OpenWorkBootstrapConfig = {
  dataMountPath: "/mnt/data",
  workspaceMountPath: "/mnt/workspace",
  runtimeDataPath: "/runtime/data",
  runtimeWorkspacePath: "/runtime/workspace",
  sidecarDir: "/runtime/sidecar",
  intervalSeconds: 60,
  keep: 3,
  port: 8787,
  workerId: "worker-1",
  clientToken: "client-token",
  hostToken: "host-token",
  activityHeartbeat: { url: "https://den.invalid/heartbeat", token: "activity-token" },
  runtimeProvider: "fake",
  imageDescription: "test image",
  rebuildHint: "rebuild the test image",
}

function assertOpencodeV2Only(script: string) {
  // The server runs the baked OpenCode v2; the image must carry it.
  assert.match(script, /OPENWORK_OPENCODE2_BIN='\/usr\/local\/bin\/opencode2'/)
  assert.match(script, /opencode2 binary missing from test image/)
  // The retired engine and its rollout switches are never configured.
  assert.doesNotMatch(script, /OPENWORK_(?:OPENCODE_BIN|MANAGE_OPENCODE|ENGINE_FORCE_POLICY|ENGINE_AUTO_UPGRADE|FRESH_INSTALL_ENGINE|ENGINE_V2_PREVIEW)=/)
  assert.doesNotMatch(script, /command -v opencode /)
  // The pre-v2 engine's history stays checkpointed so the server can copy it.
  assert.match(script, /\.local\/share\/opencode/)
}

test("bootstrap runs only OpenCode v2, ignoring stale rollout configuration", () => {
  for (const legacy of [{}, { engineV2ForceUpgrade: false }, { engineV2ForceUpgrade: true }]) {
    const script = renderOpenWorkBootstrapScript({ ...bootstrap, ...legacy })
    assertOpencodeV2Only(script)
    assert.match(script, /OPENWORK_RUNTIME_SURFACE='web'/)
    assert.ok(script.indexOf("hydrate_checkpoint\nattempt=0") < script.indexOf("OPENWORK_OPENCODE2_BIN="))
    // Bootstrap never directly removes or rewrites restored engine state.
    assert.doesNotMatch(script, /engine-v2-preview\.json|engine\.json/)
  }
})

function runtimeConfig(): CloudRuntimeOrchestratorConfig {
  return {
    instanceNamePrefix: "test",
    sharedVolumeName: "shared",
    workspaceMountPath: bootstrap.workspaceMountPath,
    dataMountPath: bootstrap.dataMountPath,
    runtimeWorkspacePath: bootstrap.runtimeWorkspacePath,
    runtimeDataPath: bootstrap.runtimeDataPath,
    sidecarDir: bootstrap.sidecarDir,
    checkpointIntervalSeconds: 60,
    checkpointKeep: 3,
    port: bootstrap.port,
    publicEndpoint: false,
    lifecycle: { autoStopMinutes: 10, autoArchiveMinutes: 60, autoDeleteMinutes: 0 },
    resources: { cpu: 2, memoryGb: 4, diskGb: 10 },
    endpointTtlSeconds: 3600,
    endpointRefreshLeadMs: 1000,
    createTimeoutMs: 1000,
    stopTimeoutMs: 1000,
    destroyTimeoutMs: 1000,
    healthcheckTimeoutMs: 1000,
    pollIntervalMs: 1,
    activityHeartbeatUrl: () => bootstrap.activityHeartbeat.url,
    bootstrap: {
      imageDescription: bootstrap.imageDescription,
      rebuildHint: bootstrap.rebuildHint,
    },
  }
}

const provisionInput = {
  workerId: bootstrap.workerId,
  name: "test-worker",
  clientToken: bootstrap.clientToken,
  hostToken: bootstrap.hostToken,
  activityToken: bootstrap.activityHeartbeat.token,
}

test("fresh launches, wakes, and restored image replacements always run only v2", async () => {
  const scripts: string[] = []
  const image = { id: "test-image", version: "old-image" }
  const provider = createFakeProvider({
    image,
    onExec: ({ spec }) => {
      if (spec.script) scripts.push(spec.script)
      return { exitCode: 0 }
    },
  })
  const store = createInMemoryRuntimeInstanceStore()
  const runtime = createCloudRuntimeOrchestrator({
    provider,
    store,
    config: runtimeConfig(),
    logger: { warn() {} },
    fetch: async () => new Response("{}"),
  })

  await runtime.provision(provisionInput)
  assertOpencodeV2Only(scripts.at(-1) ?? "")

  await runtime.stop(provisionInput.workerId)
  await runtime.wake(provisionInput)
  assertOpencodeV2Only(scripts.at(-1) ?? "")

  // A checkpoint restored onto a replacement image still runs only v2, even if
  // the checkpoint was created before v2 became the only engine.
  await runtime.stop(provisionInput.workerId)
  store.imageVersions.set(provisionInput.workerId, image.version)
  image.version = "new-image"
  provider.fake.writeVolumeFile("shared", `workers/${provisionInput.workerId}/data/checkpoints/ckpt-1.tar`)
  await runtime.wake(provisionInput)
  assertOpencodeV2Only(scripts.at(-1) ?? "")
  assert.equal(provider.fake.count("create"), 2)
  assert.equal(provider.fake.count("destroy"), 1)

  await runtime.stop(provisionInput.workerId)
  store.imageVersions.set(provisionInput.workerId, runtime.currentImageVersion())
  await runtime.wake(provisionInput)
  assertOpencodeV2Only(scripts.at(-1) ?? "")

  // Another restart must not restore the retired engine.
  await runtime.stop(provisionInput.workerId)
  await runtime.wake(provisionInput)
  assertOpencodeV2Only(scripts.at(-1) ?? "")
  assert.equal(scripts.length, 5)
})

test("bootstrap starts the document editor only when Den places it in the worker", () => {
  assert.doesNotMatch(renderOpenWorkBootstrapScript(bootstrap), /coolwsd/)
  const script = renderOpenWorkBootstrapScript({ ...bootstrap, documentsEditor: { port: 9980, wopiHost: "https://api.example.com:443", frameAncestor: "https://workbot.example.com" } })
  // Den is the only WOPI host; Workbot is the only embedder; no admin console, macros or remote UNO.
  assert.match(script, /runuser -u cool -- env aliasgroup1='https:\/\/api\.example\.com:443' coolwsd/)
  assert.match(script, /'--o:net\.frame_ancestors=https:\/\/workbot\.example\.com'/)
  for (const option of ["admin_console.enable=false", "security.enable_macros_execution=false", "security.enable_websocket_urp=false", "net.listen=loopback"]) {
    assert.ok(script.includes(`'--o:${option}'`), option)
  }
  // The engine stays on loopback; the public port restores the signed host the provider proxy rewrote.
  assert.ok(script.includes("'--port=9981'"))
  assert.match(script, /node '\/opt\/openwork\/documents-editor-proxy\.mjs' 9980 9981/)
  // An older image without the engine still serves OpenWork.
  assert.match(script, /if command -v coolwsd >\/dev\/null 2>&1 && \[ -f '\/opt\/openwork\/documents-editor-proxy\.mjs' \]; then/)
  assert.ok(script.indexOf("documents_editor_loop &") < script.indexOf("\nattempt=0"))
})
