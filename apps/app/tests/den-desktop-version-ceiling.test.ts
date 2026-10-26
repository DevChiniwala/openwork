import { describe, expect, test } from "bun:test";
import { createDenClient } from "../src/app/lib/den";
import { capDesktopVersionMetadata } from "../src/app/lib/version-gate";

describe("legacy Den update policy discovery", () => {
  test("reads the version from an actual self-hosted health response, not GitHub latest", async () => {
    const paths: string[] = [];
    const server = Bun.serve({ port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.endsWith("/v1/features")) return Response.json({deployment:"self_hosted",features:{}});
      if (path.endsWith("/health")) return Response.json({ok:true,service:"den-api",version:"0.18.59"});
      return Response.json({minAppVersion:"0.17.0",latestAppVersion:"0.18.62",publishedDesktopVersions:["0.18.59","0.18.62"]});
    }});
    try {
      const client = createDenClient({baseUrl:server.url.toString()});
      const metadata = await client.getAppVersionMetadata();
      expect(metadata.maxDesktopVersion).toBeUndefined();
      const result = capDesktopVersionMetadata(metadata,await client.getLegacyDesktopVersionCeiling());
      expect(result.latestAppVersion).toBe("0.18.59");
      expect(result.publishedDesktopVersions).toEqual(["0.18.59"]);
      expect(paths.map(path=>path.replace(/^\/api\/den/,""))).toEqual(["/v1/app-version","/v1/features","/health"]);
    } finally { server.stop(true); }
  });
  test("legacy Cloud does not consult the server build version", async () => {
    const server = Bun.serve({port:0,fetch:()=>Response.json({deployment:"cloud"})});
    try {
      expect(await createDenClient({baseUrl:server.url.toString()}).getLegacyDesktopVersionCeiling()).toBeNull();
    } finally { server.stop(true); }
  });
  test("an unknown deployment fails closed instead of guessing from the URL", async () => {
    const server = Bun.serve({port:0,fetch:()=>Response.json({})});
    try {
      await expect(createDenClient({baseUrl:server.url.toString()}).getLegacyDesktopVersionCeiling()).rejects.toThrow("Could not determine");
    } finally { server.stop(true); }
  });
});
