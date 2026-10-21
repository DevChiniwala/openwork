import { describe, expect, it } from "vitest";
import { provisionWindowsReleaseSandbox, windowsDiagnosticPolicy, windowsReleaseBinary, windowsCdpMatchesRelease } from "./windows-release.ts";
import type { DaytonaExec } from "./daytona.ts";

const release = { version: "0.18.59", distribution: "enterprise" as const };
const assetName = "openwork-enterprise-win-x64-0.18.59.exe";
const releaseFetch = (async () => Response.json({ tag_name: "v0.18.59", assets: [{ name: assetName, state: "uploaded", digest: `sha256:${"a".repeat(64)}`, size: 100, browser_download_url: `https://github.com/different-ai/openwork/releases/download/v0.18.59/${assetName}` }] })) as typeof fetch;
function fixture() {
  const calls: string[][] = []; let name = "";
  const exec: DaytonaExec = async (args) => {
    calls.push(args);
    if (args[0] === "create") name = args[args.indexOf("--name") + 1];
    if (args[0] === "info") return { code: 0, stderr: "", stdout: JSON.stringify({ id: "owned-win", name, snapshot: "windows-medium", public: false, toolboxProxyUrl: "https://proxy.example.test/toolbox" }) };
    if (args[0] === "preview-url") return { code: 0, stderr: "", stdout: `https://${args[args.indexOf("-p") + 1]}-signedtoken.proxy.example.test` };
    return { code: 0, stderr: "", stdout: "EXEC_READY WINDOWS_RELEASE_VERIFIED INSTALLED GUI_SESSION_1 OpenWork/0.18.59" };
  };
  const request = (async (url) => new Response(String(url).includes("json/version") ? "OpenWork/0.18.59" : "noVNC")) as typeof fetch;
  return { calls, exec, request };
}

describe("published Windows paths", () => {
  it.each([["public", "OpenWork.exe"], ["cloud", "OpenWork Cloud.exe"], ["enterprise", "OpenWork Enterprise.exe"]] as const)("resolves %s without aliases", (distribution, binary) => {
    expect(windowsReleaseBinary(distribution)).toBe(`C:\\Users\\Administrator\\AppData\\Local\\Programs\\@openworkdesktop\\${binary}`);
  });
});
describe("Windows CDP transport", () => {
  it("accepts only a known product and exact release version", () => {
    for (const name of ["OpenWork", "OpenWork Cloud", "OpenWork Enterprise"]) expect(windowsCdpMatchesRelease(`${name}/0.18.59`, "0.18.59")).toBe(true);
    expect(windowsCdpMatchesRelease("Chrome/100", "0.18.59")).toBe(false);
    expect(windowsCdpMatchesRelease("OpenWork/0.18.58", "0.18.59")).toBe(false);
  });
});
describe("bounded diagnostic retention", () => {
  it("requires a future bounded hard deadline when retained", () => {
    expect(() => windowsDiagnosticPolicy(true, undefined, 0)).toThrow("explicit hard deadline");
    for (const deadline of ["invalid", new Date(0).toISOString(), new Date(91 * 60_000).toISOString()]) expect(() => windowsDiagnosticPolicy(true, deadline, 0)).toThrow("1-90 minutes");
    expect(windowsDiagnosticPolicy(true, new Date(65 * 60_000 + 59_000).toISOString(), 0)).toEqual({ retain: true, ttlMinutes: 65 });
    expect(windowsDiagnosticPolicy(false, undefined)).toEqual({ retain: false });
  });
  it.each([false, true])("provisioning failure retention=%s", async (retainOnFailure) => {
    const f = fixture();
    await expect(provisionWindowsReleaseSandbox({ release, lifetimeMinutes: 45, retainOnFailure, hardDeadline: new Date(Date.now() + 60 * 60_000).toISOString(), ...f, releaseFetch, log: () => {}, onCreated: async () => { throw new Error("diagnostic failure"); } })).rejects.toThrow("diagnostic failure");
    expect(f.calls.some(args => args.includes("delete"))).toBe(!retainOnFailure);
    const create = f.calls.find(args => args[0] === "create")!;
    expect(Number(create[create.indexOf("--ttl") + 1])).toBeLessThanOrEqual(60);
  });
  it.each([false, true])("outer viewer failure is retained until TTL, but acknowledged ready cleanup=%s", async (ready) => {
    const f = fixture(); const logs: string[] = [];
    const handle = await provisionWindowsReleaseSandbox({ release, lifetimeMinutes: 45, retainOnFailure: true, hardDeadline: new Date(Date.now() + 60 * 60_000).toISOString(), ...f, releaseFetch, log: line => logs.push(line) });
    expect(handle.installPath).toContain("OpenWork Enterprise.exe");
    const scripts = f.calls.filter(args => args[0] === "exec").map(args => Buffer.from(args.at(-1)!.split(" ").at(-1)!, "base64").toString("utf16le")).join("\n");
    expect(scripts).toContain("name='OpenWork Enterprise.exe'");
    expect(scripts).not.toContain("HardLink");
    expect(scripts).toContain("Get-AuthenticodeSignature");
    expect(scripts).toContain("listenport=19825 connectaddress=127.0.0.1 connectport=9223");
    expect(f.calls.some(args => args[0] === "preview-url" && args.includes("19825"))).toBe(true);
    if (ready) handle.markReady();
    await handle[Symbol.asyncDispose]();
    expect(f.calls.some(args => args.includes("delete"))).toBe(ready);
    if (!ready) expect(logs.join("\n")).toContain("no ready viewer is claimed");
  });
});
