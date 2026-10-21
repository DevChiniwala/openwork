#!/usr/bin/env node
/** Owned cold-base replication controller. Never snapshots an authenticated VM.
 * API keys stay in this controller; the local socket and receipt contain no keys.
 * Starts ONE signed-out canary; fanout is a separate explicit socket command.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { provisionDesktopSandbox, defaultDaytonaExec } from "../../evals/packages/hosts/src/index.ts";
import { daytonaSandbox } from "../../evals/packages/hosts/src/resolve.ts";
import { listTargets, connect, debuggerUrlFor } from "../../evals/packages/cdp/src/cdp.ts";
import { waitForNoVnc } from "./preview.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const [receiptArg, deadlineArg] = process.argv.slice(2);
assert(receiptArg && deadlineArg, "Usage: workshop-replicate.mjs <private receipt.json> <absolute event deadline>");
const receiptPath = resolve(receiptArg), directory = dirname(receiptPath), socketPath = `${directory}/replication.sock`;
assert(!receiptPath.startsWith(root + "/"), "Receipt must be outside git");
const deadline = Date.parse(deadlineArg), sourceSha = process.env.OPENWORK_EVAL_REF;
assert(Number.isFinite(deadline) && deadline > Date.now(), "Future fixed deadline required");
assert(/^[a-f0-9]{40}$/.test(sourceSha || ""), "Pin OPENWORK_EVAL_REF to an exact pushed SHA");
assert(process.env.DAYTONA_API_KEY && process.env.DAYTONA_API_URL === "https://app.daytona.io/api", "Scoped Daytona controller credentials required");
const load = () => JSON.parse(readFileSync(receiptPath, "utf8"));
const update = (fn) => { const r = load(); fn(r); writeFileSync(receiptPath, JSON.stringify(r, null, 2), { mode: 0o600 }); };
const initial = load();
assert(initial.status.startsWith("pilot-passed"), "Existing functional pilot must have passed");
const failedOwnedCanary = initial.replication?.canaryStatus === "blocked-retained" && initial.templateBuild?.status === "active" && initial.templateBuild?.neverAuthenticated;
const replaceAuditStoppedBuilder = failedOwnedCanary && initial.replication.template.snapshotId !== initial.templateBuild.snapshotId;
const resumeExistingCanary = failedOwnedCanary && initial.replication.template.snapshotId === initial.templateBuild.snapshotId && initial.replication.seats.length === 1 && initial.replication.seats[0].status === "failed-retained";
assert(!initial.replication || replaceAuditStoppedBuilder || resumeExistingCanary, "Existing replication receipt: attach its controller, never recreate blindly");
const raw = execFileSync(process.execPath, ["evals/bin/world.mjs", "outputs", "workshop", "--stage", initial.stage, "--reveal", "--json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const outputs = Object.fromEntries(Object.entries(JSON.parse(raw.trim().split("\n").at(-1)).outputs).map(([k, v]) => [k, v.value]));
const headers = { authorization: `Bearer ${process.env.DAYTONA_API_KEY}`, "content-type": "application/json" };
const api = async (path, method = "GET", body) => {
  const r = await fetch(`https://app.daytona.io/api${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
  assert(r.ok, `Daytona ${method} failed HTTP ${r.status}`); const t = await r.text(); return t ? JSON.parse(t) : null;
};
const redact = (s) => String(s).replace(/https?:\/\/[^\s"<>]+/g, "[private-url]").replace(/[a-z0-9-]+\.daytonaproxy[0-9]+\.net/g, "[private-host]");
const log = (s) => { appendFileSync(`${directory}/replication.log`, `${new Date().toISOString()} ${redact(s)}\n`, { mode: 0o600 }); console.log(redact(s)); };
if (replaceAuditStoppedBuilder) {
  const cleanupDeadline = Date.now() + 60000; let deleted = false;
  while (Date.now() < cleanupDeadline) {
    const check = await fetch(`https://app.daytona.io/api/sandbox/${initial.templateBuild.builderId}`, { headers });
    if (check.status === 404) { deleted = true; break; }
    assert(check.ok, "Owned builder cleanup check failed");
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert(deleted, "Temporary builder must be deleted before canary allocation");
  update(r => { r.templateBuild.builderCleanup = "deletion confirmed HTTP 404"; });
}
const snapshotName = replaceAuditStoppedBuilder || resumeExistingCanary ? initial.templateBuild.snapshotName : "openwork-eval-vnc";
const snapshot = await api(`/snapshots/${snapshotName}`);
assert.equal(snapshot.state.toLowerCase(), "active", "Software base must be active");
assert(snapshot.id && snapshot.name === snapshotName);
if (replaceAuditStoppedBuilder || resumeExistingCanary) assert.equal(snapshot.id, initial.templateBuild.snapshotId);
const recipe = readFileSync(`${root}/.devcontainer/Dockerfile.daytona-vnc`, "utf8");
assert(recipe.includes("git clone") && recipe.includes("rm -rf") && !/sign-in|authToken|OPENAI_API_KEY/.test(recipe), "Review the clean base recipe");
const template = { kind: replaceAuditStoppedBuilder ? "owned-never-authenticated-cold-software-snapshot" : "maintained-clean-base-plus-per-clone-bootstrap", snapshotId: snapshot.id, snapshotName: snapshot.name, recipeSha256: createHash("sha256").update(recipe).digest("hex"), sourceSha, newSnapshotCreated: Boolean(replaceAuditStoppedBuilder), authenticatedPilotCaptured: false, ...(replaceAuditStoppedBuilder ? { finalAudit: initial.templateBuild.finalAudit } : {}) };
const seats = new Map(); let canaryMember, approval = false, fanoutRunning = false;
let canaryResolve; const canaryReady = new Promise(resolve => { canaryResolve = resolve; });
if (!resumeExistingCanary) update(r => { if (replaceAuditStoppedBuilder) r.priorTemplateAudit = r.replication; r.replication = { template, deadline: new Date(deadline).toISOString(), socketPath, seats: [], canaryStatus: "preparing", fanoutStatus: "not-started", maxAdditionalComputeAndCanaryModelUsd: 15 }; });

async function capacity(count) {
  const backend = await api(`/sandbox/${initial.finalResources.find(s => s.role === "backend").id}`);
  const usage = await api(`/organizations/${backend.organizationId}/usage`);
  const pool = usage.regionUsage.find(p => p.regionId === "us" && p.sandboxClass === "container");
  assert(pool, "US container quota pool required");
  assert(pool.currentCpuUsage + count * 4 + 8 <= pool.totalCpuQuota, "CPU reserve insufficient");
  assert(pool.currentMemoryUsage + count * 8 + 16 <= pool.totalMemoryQuota, "Memory reserve insufficient");
  assert(pool.currentDiskUsage + count * 10 + 20 <= pool.totalDiskQuota, "Disk reserve insufficient");
  const remainingHours = (deadline - Date.now()) / 3600000;
  const bound = 19 * (4 * 0.0504 + 8 * 0.0162 + 10 * 0.000108) * remainingHours + 5.5;
  assert(bound <= 15, "Incremental 19-seat compute plus canary $5 model cap exceeds $15");
  assert(deadline - Date.now() > (count > 1 ? 45 : 15) * 60000, "Not enough fixed-event lifetime; renewal must be explicit");
  const facts = { observedAt: new Date().toISOString(), pool, activeSnapshots: usage.currentSnapshotUsage, snapshotLimit: usage.totalSnapshotQuota, newSnapshots: 0, newVolumes: 0, remainingToLaunch: count, worstCaseAdditional19ComputePlusCanaryModelUsd: bound };
  update(r => { r.replication.capacity = facts; }); return facts;
}
const remote = async (sandbox, source, rootAudit = false) => {
  const payload = Buffer.from(source).toString("base64");
  const r = await defaultDaytonaExec(["exec", sandbox, "--", `${rootAudit ? "sudo -n " : ""}node -e "eval(Buffer.from('${payload}','base64').toString())"`], { timeoutMs: 120000 });
  assert.equal(r.code, 0, `Owned remote check failed: ${redact(r.stdout + r.stderr).slice(-400)}`);
  return r.stdout.trim().split("\n").at(-1);
};
async function baseAudit(sandbox) {
  const data = await remote(sandbox, `const fs=require('node:fs');const roots=['/home/daytona','/root'];const bad=[];const paths=['.git-credentials','.netrc','.aws/credentials','.ssh/id_rsa','.ssh/id_ed25519','.config/chromium/Default/Cookies','.config/google-chrome/Default/Cookies','.config/OpenWork','.config/openwork-desktop','.config/openwork','.config/opencode/auth.json','.local/share/opencode/auth.json','.local/share/opencode/opencode.db'];for(const root of roots)for(const p of paths)if(fs.existsSync(root+'/'+p))bad.push(root+'/'+p);for(const p of ['/workspace/.env','/workspace/.env.dev','/workspace/.env.local','/workspace/.openwork-daytona/desktop-bootstrap.json','/workspace/.openwork-daytona/den-env.sh'])if(fs.existsSync(p))bad.push(p);const processes=fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x)).flatMap(p=>{try{return [fs.readFileSync('/proc/'+p+'/comm','utf8').trim()]}catch{return[]}}).filter(x=>/^(electron|chromium|chrome|mysqld)$/.test(x));const sharedSecretsMounted=fs.readFileSync('/proc/mounts','utf8').includes('/daytona-secrets');console.log(JSON.stringify({credentialOrPersonalPaths:bad,appBrowserOrBackendProcesses:processes,sharedSecretsMounted}));`, true);
  const audit = JSON.parse(data); assert.equal(audit.credentialOrPersonalPaths.length, 0, "Base contains personal/credential residue; stop before app launch"); assert.equal(audit.appBrowserOrBackendProcesses.length, 0); assert.equal(audit.sharedSecretsMounted, false); return audit;
}
async function signedUrl(sandbox, port) {
  const expiry = Math.max(60, Math.floor((deadline - Date.now()) / 1000));
  const result = await defaultDaytonaExec(["preview-url", sandbox, "-p", String(port), "--expires", String(expiry)], { timeoutMs: 60000 });
  assert.equal(result.code, 0); const value = result.stdout.match(/https:\/\/[^\s"<>]+/)?.[0]; assert(value); return value;
}
const writeSeat = (record) => update(r => { const i = r.replication.seats.findIndex(s => s.number === record.number); if (i < 0) r.replication.seats.push(record); else r.replication.seats[i] = record; });
async function launch(number, resume = false) {
  const record = resume ? initial.replication.seats.find(s => s.number === number) : { number, key: `seat-${String(number).padStart(2, "0")}`, status: "allocating", signedIn: false, sourceSha, snapshotId: snapshot.id };
  assert(record && record.signedIn === false && record.snapshotId === snapshot.id);
  if (resume) { const info = await api(`/sandbox/${record.id}`); assert.equal(info.labels["ww-parallel-stage"], initial.stage); assert.equal(info.public, false); assert(Date.parse(info.autoDestroyAt) <= deadline); record.status = "repairing-owned-canary"; delete record.error; }
  writeSeat(record); const profileRoot = `/tmp/ww-parallel-seat-${number}-fresh`;
  const exec = async (args, options) => {
    if (resume && args[0] === "sandbox" && args[1] === "start") {
      assert.equal(args[2], record.id); const info = await api(`/sandbox/${record.id}`);
      return info.state === "stopped" ? defaultDaytonaExec(["start", record.id], options) : { code: 0, stdout: "Owned canary is already starting/started", stderr: "" };
    }
    if (args[0] === "snapshot" && args[1] === "list") return { code: 0, stdout: JSON.stringify([{ id: snapshot.id, name: snapshot.name }]), stderr: "" };
    if (args[0] === "create") assert.equal(args[args.indexOf("--snapshot") + 1], snapshot.id, "Immutable base ID must not drift");
    return defaultDaytonaExec(args, options);
  };
  try {
    const provisioned = await provisionDesktopSandbox({ ref: sourceSha, name: `ww-parallel-${record.key}`, snapshot: snapshot.name, ...(resume ? { reuse: record.id } : { private: true }), secrets: false, autoStopMinutes: 0, skipDesktopWarmup: true, retainOnFailure: true, exec,
      onExecReady: async sandbox => {
        if (!record.baseAudit) record.baseAudit = await baseAudit(sandbox);
        assert.deepEqual(record.baseAudit.credentialOrPersonalPaths, []);
        // The image intentionally omits the tracked public dev config. Restore
        // only that reviewed blob for Git's clean-source gate; remove it again
        // in onPrepared, before any browser/app startup. Never relax dirty checks.
        const prepared = JSON.parse(await remote(sandbox, `const fs=require('node:fs'),cp=require('node:child_process');const p='/workspace/.env.dev';const blob=cp.execFileSync('git',['-C','/workspace','show','HEAD:.env.dev']);if(fs.existsSync(p)&&!fs.readFileSync(p).equals(blob))throw Error('Unexpected env residue');if(!fs.existsSync(p))fs.writeFileSync(p,blob);console.log(JSON.stringify({reviewedPublicBuildConfigRestored:true}));`));
        assert(prepared.reviewedPublicBuildConfigRestored); record.publicDevConfigBuildOnly = true; writeSeat(record);
      },
      log: line => log(`${record.key} ${line}`),
      onPrepared: async sandbox => {
        // Git checkout can restore the public repository's demo .env.dev. It is
        // not a private credential, but no root dev env is allowed in attendees.
        const cleaned = JSON.parse(await remote(sandbox, `const fs=require('node:fs'),cp=require('node:child_process');const p='/workspace/.env.dev';if(fs.existsSync(p)){if(!fs.readFileSync(p).equals(cp.execFileSync('git',['-C','/workspace','show','HEAD:.env.dev'])))throw Error('Unexpected env content');fs.unlinkSync(p)}console.log(JSON.stringify({rootDevEnvAbsent:!fs.existsSync(p)}));`));
        assert(cleaned.rootDevEnvAbsent); record.preLaunchDevEnvAbsent = true; writeSeat(record);
      },
      onCreated: async name => {
        const info = await api(`/sandbox/${name}`); record.id = info.id; record.name = info.name; record.status = "auditing-base"; writeSeat(record);
        const ttl = Math.floor((deadline - 60000 - Date.now()) / 60000); assert(ttl >= 10);
        await api(`/sandbox/${info.id}/labels`, "PUT", { labels: { ...info.labels, "ww-parallel-stage": initial.stage, "ww-parallel-seat": String(number), "ww-parallel-owner": "workshop-world" } });
        await api(`/sandbox/${info.id}/ttl/${ttl}`, "POST");
        const confirmed = await api(`/sandbox/${info.id}`); assert.equal(confirmed.public, false); assert(Date.parse(confirmed.autoDestroyAt) <= deadline); record.autoDestroyAt = confirmed.autoDestroyAt;
        writeSeat(record);
      },
    });
    record.sourceReceipt = provisioned.source; assert.equal(provisioned.source.actualSha, sourceSha);
    const host = daytonaSandbox(provisioned.sandbox);
    const handle = await host.spawnElectron(`ww-parallel-${record.key}`, { profileDir: profileRoot, bootstrap: { baseUrl: outputs.denWeb, apiBaseUrl: outputs.denApi, requireSignin: true }, env: { VITE_DISABLE_OPENWORK_MODELS: "0", OPENWORK_AUTOMATION_RUNNER: "off" }, startupTimeoutMs: 420000 });
    const ts = await listTargets(handle.cdpUrl); const target = ts.find(t => t.title === "OpenWork"); assert(target);
    const client = await connect(debuggerUrlFor(handle.cdpUrl, target));
    let auth;
    try { auth = await evaluate(client, `({tokenPresent:!!localStorage.getItem('openwork.den.authToken'),sessionOriginPresent:!!localStorage.getItem('openwork.den.sessionOrigin'),text:document.body.innerText.slice(0,2500)})`); } finally { client.close(); }
    assert.equal(auth.tokenPresent, false, "Clone must remain signed out");
    const probe = JSON.parse(await remote(record.id, `(async()=>{const result={};for(const [name,url] of Object.entries(${JSON.stringify({ api: outputs.denApi + "/health", ready: outputs.denApi + "/ready", web: outputs.denWeb, workplace: outputs.workplace + "/health" })})){const r=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(15000)});result[name]={status:r.status,contentType:r.headers.get('content-type')};if(r.status!==200)throw Error(name+' HTTP '+r.status);if(name==='web'){const html=await r.text();if(!/openwork/i.test(html)||/preview warning|visit site/i.test(html))throw Error('Wrong web HTML')}else{const body=await r.json();result[name].service=body.service;result[name].ok=body.ok;if(name==='api'&&(body.ok!==true||body.service!=='den-api'))throw Error('Wrong Den health');if(name==='ready'){result[name].database=body.checks?.database;if(body.checks?.database!=='ok')throw Error('Database not ready')}if(name==='workplace'&&(body.ok!==true||body.service!=='open-workplace-workshop'))throw Error('Wrong workplace')}}console.log(JSON.stringify(result));})().catch(e=>{console.log(JSON.stringify({error:e.message}));process.exitCode=1})`));
    record.denReachability = probe;
    const unsigned = await api(`/sandbox/${record.id}/ports/6080/preview-url`); const denied = await fetch(unsigned.url, { redirect: "manual", signal: AbortSignal.timeout(15000) }); assert.equal(denied.status, 401);
    const viewer = new URL(await signedUrl(record.id, 6080)); for (const [k, v] of Object.entries({ autoconnect: "1", resize: "scale", reconnect: "1", reconnect_delay: "2000" })) viewer.searchParams.set(k, v);
    await waitForNoVnc(viewer.href);
    record.status = "signed-out-ready"; record.authBeforeSignin = { tokenPresent: false, sessionOriginPresent: auth.sessionOriginPresent }; record.unsignedViewerStatus = 401; record.signedViewerRfbPassed = true; record.profileRoot = profileRoot; record.cdpPort = handle.meta.cdpPort; record.targetId = target.id; record.verifiedAt = new Date().toISOString();
    seats.set(number, { host, handle, viewerUrl: viewer.href, record }); writeSeat(record); log(`${record.key} signed-out app, Den reachability, private viewer and fixed TTL verified`); return record;
  } catch (e) { record.status = "failed-retained"; record.error = redact(e.message).slice(0,600); writeSeat(record); throw e; }
}
async function evaluate(client, expression) {
  const r = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  assert(!r.exceptionDetails, r.exceptionDetails?.exception?.description || "Browser evaluation failed"); return r.result?.value;
}
async function attached(number, port, id, action) {
  const seat = seats.get(number); assert(seat, "Attach only to owned prepared seat");
  const base = port === Number(seat.record.cdpPort) ? seat.handle.cdpUrl : await signedUrl(seat.record.id, port);
  const ts = await listTargets(base); const target = ts.find(t => t.id === id); assert(target, "Explicit current target required"); const c = await connect(debuggerUrlFor(base, target));
  try { return await action(c); } finally { c.close(); }
}
async function createCanaryMember() {
  const request = async (path, body, token) => {
    const response = await fetch(outputs.denApi + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    const value = await response.json(); assert(response.ok, `Owned Den request failed HTTP ${response.status}`); return value;
  };
  const admin = await request("/api/auth/sign-in/email", { email: outputs.adminEmail, password: outputs.adminPassword }); assert(admin.token);
  const email = `attendee-02-${randomBytes(4).toString("hex")}@example.test`, password = `Workshop-${randomBytes(20).toString("base64url")}`;
  const invitation = await request("/v1/invitations", { email, role: "member" }, admin.token); assert(invitation.inviteToken);
  await request("/api/auth/sign-up/email", { email, name: "Attendee 02", password });
  const signed = await request("/api/auth/sign-in/email", { email, password }); assert(signed.token);
  await request("/v1/orgs/invitations/accept", { id: invitation.inviteToken }, signed.token);
  const inventory = await request("/v1/inference-providers?scope=usable", undefined, signed.token);
  const model = inventory.inferenceProviders?.find(p => p.credentialStatus === "ready" && p.models?.some(m => m.upstreamModelId === "gpt-6.1-sol")); assert(model);
  const limits = await request("/v1/gateway/usage-limits/me", undefined, signed.token); assert(limits.buckets?.some(b => b.hardLimit && b.allowanceMicroUsd === 5000000));
  canaryMember = { email, password, token: signed.token }; update(r => { r.replication.canaryMember = { email, ordinaryMember: true, usableModel: true, hardLimitUsd: 5 }; });
}
async function browser(number) {
  const seat = seats.get(number); assert(seat && !seat.browser);
  const profile = `${seat.record.profileRoot}/browser`, launcher = `${seat.record.profileRoot}/launch-browser`;
  const script = `const fs=require('node:fs'),cp=require('node:child_process');const dir=${JSON.stringify(seat.record.profileRoot)},profile=${JSON.stringify(profile)},launcher=${JSON.stringify(launcher)};fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(launcher,'#!/usr/bin/env bash\\nexec chromium --no-sandbox --disable-dev-shm-usage --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 --user-data-dir='+profile+' "$@"\\n',{mode:0o700});const apps=process.env.HOME+'/.local/share/applications';fs.mkdirSync(apps,{recursive:true});fs.writeFileSync(apps+'/ww-parallel-browser.desktop','[Desktop Entry]\\nType=Application\\nName=Workshop Browser\\nExec='+launcher+' %U\\nMimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;\\n');for(const type of ['x-scheme-handler/http','x-scheme-handler/https','text/html'])cp.spawnSync('xdg-mime',['default','ww-parallel-browser.desktop',type]);const out=fs.openSync(dir+'/browser.log','a');cp.spawn(launcher,['about:blank'],{env:{...process.env,DISPLAY:':99'},detached:true,stdio:['ignore',out,out]}).unref();console.log(JSON.stringify({started:true,profile}));`;
  const result = await remote(seat.record.id, script); seat.browser = { port: 9222, profile }; return JSON.parse(result);
}
async function dispatch(q) {
  if (q.action === "status") return load().replication;
  if (q.action === "waitCanary") { await canaryReady; return load().replication; }
  if (q.action === "targets") { const s = seats.get(q.seat); assert(s); const base = q.port === Number(s.record.cdpPort) ? s.handle.cdpUrl : await signedUrl(s.record.id, q.port); return (await listTargets(base)).map(t => ({ id: t.id, title: t.title, path: new URL(t.url).pathname, type: t.type })); }
  if (q.action === "browser") return browser(q.seat);
  if (q.action === "eval") return attached(q.seat, q.port, q.target, c => evaluate(c, q.expression));
  if (q.action === "click") return attached(q.seat, q.port, q.target, async c => { const point = await evaluate(c, `(()=>{const e=document.querySelector(${JSON.stringify(q.selector)});if(!e||e.disabled)throw Error('Missing enabled control');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 }); return { clicked: true }; });
  if (q.action === "key") return attached(q.seat, q.port, q.target, async c => { for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, key: q.key, code: q.key, windowsVirtualKeyCode: q.key === "Enter" ? 13 : 27, modifiers: q.modifiers || 0 }); return true; });
  if (q.action === "navigate") return attached(q.seat, q.port, q.target, c => c.send("Page.navigate", { url: q.site === "den" ? outputs.denWeb + (q.path || "") : q.site === "workplace" ? outputs.workplace + (q.path || "") : q.url }));
  if (q.action === "fillCanaryLogin") { assert(q.seat === 2 && canaryMember); return attached(2, q.port, q.target, c => evaluate(c, `(()=>{const fields=[...document.querySelectorAll('input')];for(const [type,value]of [['email',${JSON.stringify(canaryMember.email)}],['password',${JSON.stringify(canaryMember.password)}]]){const e=fields.find(e=>e.type===type);if(!e)continue;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}return fields.map(e=>({type:e.type,name:e.name}));})()`)); }
  if (q.action === "shot") return attached(q.seat, q.port, q.target, async c => { assert(/^[a-z0-9-]+$/.test(q.name)); await c.send("Page.bringToFront"); const r = await c.send("Page.captureScreenshot", { format: "png" }); const path = `${directory}/${q.name}.png`; writeFileSync(path, Buffer.from(r.data, "base64")); update(x => x.evidencePaths.push(path)); return { path }; });
  if (q.action === "approveCanary") { const r = load(); assert(r.replication.canaryEvidence?.normalDesktopSignin && r.replication.canaryEvidence?.independentGuest && r.replication.canaryEvidence?.pilotMarkerDenied && r.replication.canaryEvidence?.paidTaskComplete, "Measured canary evidence missing"); approval = true; const canary = seats.get(2); assert(canary); canary.record.status = "canary-signed-in-ready"; canary.record.signedIn = true; writeSeat(canary.record); update(x => { x.replication.canaryStatus = "passed"; }); return { approved: true }; }
  if (q.action === "fanout") { assert(approval && !fanoutRunning); await capacity(18); fanoutRunning = true; update(r => { r.replication.fanoutStatus = "running"; }); const queue = Array.from({ length: 18 }, (_, i) => i + 3); void Promise.all(Array.from({ length: 2 }, async () => { for (let n = queue.shift(); n; n = queue.shift()) { try { await launch(n); } catch (e) { log(`Seat ${n} failed and retained: ${redact(e.message)}`); queue.length = 0; } } })).then(() => update(r => { r.replication.fanoutStatus = r.replication.seats.length === 19 && r.replication.seats.every(s => s.status === "signed-out-ready" || s.status === "canary-signed-in-ready") ? "checks-complete" : "incomplete"; })); return { launched: true, concurrency: 2 }; }
  throw Error("Unsupported controller action");
}
if (existsSync(socketPath)) throw Error("Controller socket already exists; inspect the existing controller rather than replacing it");
const server = createServer(socket => { let input = ""; socket.on("data", chunk => { input += chunk; if (!input.includes("\n")) return; socket.removeAllListeners("data"); void dispatch(JSON.parse(input.split("\n")[0])).then(result => socket.end(JSON.stringify({ ok: true, result }) + "\n"), error => socket.end(JSON.stringify({ ok: false, error: redact(error.message) }) + "\n")); }); });
server.listen(socketPath, () => chmodSync(socketPath, 0o600));
process.on("SIGTERM", () => { server.close(); try { unlinkSync(socketPath); } catch {} process.exit(0); });
setTimeout(() => { server.close(); process.exit(0); }, Math.max(1, deadline - Date.now()));
try { await capacity(resumeExistingCanary ? 18 : 19); await launch(2, resumeExistingCanary); await createCanaryMember(); update(r => { r.replication.canaryStatus = "signed-out-ready-awaiting-normal-signin"; }); log("Canary prepared; credentials stay in controller memory. Normal UI sign-in is next."); }
catch (e) { update(r => { r.replication.canaryStatus = "blocked-retained"; r.replication.blocker = redact(e.message).slice(0,600); }); log(`Canary blocked: ${redact(e.message)}`); }
finally { canaryResolve(); }
