#!/usr/bin/env node
/** Convert ONLY the never-authenticated, audit-stopped owned builder into a cold software template. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { provisionDesktopSandbox, defaultDaytonaExec } from "../../evals/packages/hosts/src/index.ts";
const [receiptPath] = process.argv.slice(2);
const resumePreparedSoftware = process.argv.includes("--resume-after-software");
const read = () => JSON.parse(readFileSync(receiptPath, "utf8"));
const save = f => { const r = read(); f(r); writeFileSync(receiptPath, JSON.stringify(r, null, 2)); };
const r = read();
assert.equal(r.replication.canaryStatus, "blocked-retained");
assert.equal(r.replication.fanoutStatus, "not-started");
assert.equal(r.replication.seats.length, 1);
const builder = r.replication.seats[0]; assert.equal(builder.status, "failed-retained"); assert.equal(builder.signedIn, false);
const sha = r.replication.template.sourceSha;
const name = `ww-parallel-software-${sha.slice(0, 10)}`;
const h = { authorization: `Bearer ${process.env.DAYTONA_API_KEY}`, "content-type": "application/json" };
const api = async (path, method = "GET", body) => { const z = await fetch("https://app.daytona.io/api" + path, { method, headers: h, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) }); assert(z.ok, `Template API HTTP ${z.status}`); const t = await z.text(); return t ? JSON.parse(t) : null; };
const own = await api(`/sandbox/${builder.id}`); assert.equal(own.labels["ww-parallel-stage"], r.stage); assert.equal(own.public, false); assert.equal(own.state, "started");
assert(Date.parse(own.autoDestroyAt) > Date.now() + 30 * 60000, "Insufficient existing builder lifetime; do not extend it");
if (!resumePreparedSoftware) save(x => { x.templateBuild = { builderId: builder.id, snapshotName: name, sourceSha: sha, status: "preparing", neverAuthenticated: true, provenance: "fresh maintained base, stopped by pre-launch audit before first app; not the pilot" }; });
const remote = async source => { const p = Buffer.from(source).toString("base64"); const z = await defaultDaytonaExec(["exec", builder.id, "--", `sudo -n node -e "eval(Buffer.from('${p}','base64').toString())"`], { timeoutMs: 120000 }); assert.equal(z.code, 0, "Owned builder operation failed: " + (z.stderr + z.stdout).replace(/https?:\/\/[^\s]+/g, "[url]").slice(-1000)); return JSON.parse(z.stdout.trim().split("\n").at(-1)); };
if (!resumePreparedSoftware) {
const publicEnv = await remote(`const fs=require('node:fs'),cp=require('node:child_process'),crypto=require('node:crypto');const s=fs.readFileSync('/workspace/.env.dev');const tracked=cp.execFileSync('git',['-C','/workspace','show','HEAD:.env.dev']);if(!s.equals(tracked))throw Error('Unexpected private env residue');console.log(JSON.stringify({matchesPublicTrackedBlob:true,sha256:crypto.createHash('sha256').update(s).digest('hex')}));`);
save(x => { x.templateBuild.originalPublicDevConfig = publicEnv; });
const exec = async (args, options) => args[0] === "sandbox" && args[1] === "start" ? { code: 0, stdout: "Owned builder already verified started", stderr: "" } : defaultDaytonaExec(args, options);
await provisionDesktopSandbox({ ref: sha, name: "ww-parallel-software-builder", reuse: builder.id, secrets: false, autoStopMinutes: 0, skipDesktopWarmup: true, retainOnFailure: true, exec,
  onPrepared: async () => {
    const clean = await remote(`const fs=require('node:fs'),cp=require('node:child_process');const p='/workspace/.env.dev';if(fs.existsSync(p)){const a=fs.readFileSync(p),b=cp.execFileSync('git',['-C','/workspace','show','HEAD:.env.dev']);if(!a.equals(b))throw Error('Env differs from public source');fs.unlinkSync(p)}console.log(JSON.stringify({rootDevEnvRemoved:!fs.existsSync(p)}));`);
    assert(clean.rootDevEnvRemoved);
  }, log: line => console.log(line.replace(/https?:\/\/[^\s]+/g, "[public-or-private-url]")),
});
}
const clean = await remote(`const fs=require('node:fs'),cp=require('node:child_process');for(const p of ['/workspace/.env.dev','/workspace/.openwork-daytona/profiles','/tmp/warmup-profile','/home/daytona/.config/chromium','/home/daytona/.cache/chromium','/root/.config/chromium','/root/.cache/chromium','/tmp/xdgtest.log','/tmp/warmup-electron.log'])fs.rmSync(p,{recursive:true,force:true});const paths=['/workspace/.env.dev','/workspace/.openwork-daytona/desktop-bootstrap.json','/home/daytona/.git-credentials','/root/.git-credentials','/home/daytona/.config/openwork','/root/.config/openwork','/home/daytona/.config/opencode/auth.json','/root/.config/opencode/auth.json','/home/daytona/.local/share/opencode/auth.json','/home/daytona/.local/share/opencode/opencode.db','/daytona-secrets'];const residue=paths.filter(p=>fs.existsSync(p));const apps=fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).flatMap(p=>{try{return[fs.readFileSync('/proc/'+p+'/comm','utf8').trim()]}catch{return[]}}).filter(p=>/^(electron|chromium|chrome|mysqld)$/.test(p));const sourceSha=cp.execFileSync('git',['-C','/workspace','rev-parse','HEAD'],{encoding:'utf8'}).trim();console.log(JSON.stringify({residue,apps,sourceSha,sharedSecretsMounted:fs.readFileSync('/proc/mounts','utf8').includes('/daytona-secrets')}));`);
assert.deepEqual(clean.residue, []); assert.deepEqual(clean.apps, []); assert.equal(clean.sharedSecretsMounted, false); assert.equal(clean.sourceSha, sha);
save(x => { x.templateBuild.finalAudit = clean; x.templateBuild.status = "cold-capture"; });
await api(`/sandbox/${builder.id}/stop`, "POST");
const wait = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 1500)); } throw Error("Provider state deadline reached; preserve owned builder"); };
await wait(async () => (await api(`/sandbox/${builder.id}`)).state === "stopped", 120000);
await api(`/sandbox/${builder.id}/snapshot`, "POST", { name, includeMemory: false });
const snapshot = await wait(async () => { const s = await api(`/snapshots/${name}`); if (["error","failed"].includes(s.state.toLowerCase())) throw Error("Owned software snapshot failed"); return s.state.toLowerCase() === "active" ? s : null; }, 600000);
save(x => { x.templateBuild.status = "active"; x.templateBuild.snapshotId = snapshot.id; x.templateBuild.includeMemory = false; x.templateBuild.noDenBindingOrMemberState = true; });
// Deleting only this never-authenticated temporary builder is explicitly owned cleanup.
await api(`/sandbox/${builder.id}`, "DELETE");
save(x => { x.templateBuild.builderCleanup = "delete requested after active cold snapshot"; });
console.log(JSON.stringify({snapshotId:snapshot.id,snapshotName:name,sourceSha:sha,includeMemory:false,builderId:builder.id,builderDeletionRequested:true}));
