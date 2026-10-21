import { build } from "esbuild";
import { copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["src/desktop-guest.mjs"], outfile: "dist/desktop-guest.mjs", bundle: true,
  platform: "node", format: "esm", target: "node22",
  // TypeScript's bundled CommonJS runtime also resolves its own file location.
  // The guest is a standalone ESM file with no installed node_modules.
  banner: { js: "import { createRequire } from 'node:module'; import { fileURLToPath as guestFileURLToPath } from 'node:url'; import { dirname as guestDirname } from 'node:path'; const require = createRequire(import.meta.url); const __filename = guestFileURLToPath(import.meta.url); const __dirname = guestDirname(__filename);" },
});
await copyFile(new URL("../../../apps/den-worker-runtime/scripts/cloud-desktop.sh", import.meta.url), new URL("../dist/cloud-desktop.sh", import.meta.url));

// Compatibility follows source and locked dependencies, not platform-specific
// bundler output or the optional packages present in a developer's install.
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const fingerprint = createHash("sha256");
async function include(relative) {
  let bytes;
  try { bytes = await readFile(join(root, relative)); }
  catch (error) { if (error.code === "ENOENT") return; if (error.code !== "EISDIR") throw error; }
  if (bytes) { fingerprint.update(relative).update("\0").update(bytes).update("\0"); return; }
  for (const entry of (await readdir(join(root, relative))).sort()) await include(`${relative}/${entry}`);
}
for (const relative of [
  "pnpm-lock.yaml", "packages/computer-use/package.json", "packages/computer-use/src",
  "packages/codemode/package.json", "packages/codemode/src",
  "ee/packages/headless-computer/package.json", "ee/packages/headless-computer/Dockerfile.desktop",
  "ee/packages/headless-computer/src/image.ts", "ee/packages/headless-computer/requirements-desktop.lock",
  "ee/packages/headless-computer/src/desktop.ts", "ee/packages/headless-computer/src/desktop-apps.mjs",
  "ee/packages/headless-computer/src/desktop-guest.mjs", "ee/packages/headless-computer/src/viewer-tickets.mjs", "ee/packages/headless-computer/src/desktop-scripting.mjs",
  "ee/packages/headless-computer/src/scripting", "ee/packages/headless-computer/scripts/build-desktop.mjs",
  "ee/packages/headless-computer/scripts/desktop-bridge.py", "ee/packages/headless-computer/scripts/vnc-stdio.py", "ee/packages/headless-computer/scripts/configure-desktop-files.sh",
  "ee/packages/headless-computer/scripts/install-desktop-apps.sh",
  "ee/apps/den-worker-runtime/scripts/cloud-desktop.sh",
]) await include(relative);
for (const name of (await readdir(join(root, "packages/computer-use"))).sort()) {
  if ((name.endsWith(".mjs") && !name.endsWith(".test.mjs")) || name.endsWith(".py")) await include(`packages/computer-use/${name}`);
}
await writeFile(new URL("../dist/desktop-guest.version", import.meta.url), `${fingerprint.digest("hex")}\n`);
