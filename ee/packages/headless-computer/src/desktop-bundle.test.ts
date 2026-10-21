import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { build } from "esbuild"

test("the deployed desktop bundle validates its image without local package assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-bundle-"))
  try {
    const output = join(directory, "desktop.mjs")
    await build({ entryPoints: [fileURLToPath(new URL("./desktop.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm" })
    const imageIdentity = await readFile(new URL("../dist/desktop-guest.version", import.meta.url))
    for (const privateBrowsing of [false, true]) {
      const expected = createHash("sha256").update(imageIdentity).update(privateBrowsing ? "private-browsing" : "").digest("hex")
      // This standalone module has no adjacent dist/ directory, just like a
      // deployed celld Worker. Its helper must still receive the image hash.
      const program = `import assert from 'node:assert/strict';
        import { Desktop } from ${JSON.stringify(pathToFileURL(output).href)};
        let started = false;
        const provider = { describe: () => ({ platform: { os: 'linux' } }), blocks: { run: async (_box, input) => {
          if (input.command.includes(' start ')) { assert.ok(input.command.endsWith(${JSON.stringify(expected)})); started = true; return { exitCode: 0, stdout: '', stderr: '' }; }
          return { exitCode: 0, stdout: JSON.stringify({ version: started ? ${JSON.stringify(expected)} : 'old-image' }), stderr: '' };
        } } };
        await new Desktop(provider, { privateBrowsing: ${privateBrowsing} }).start({ ref: { id: 'isolated' } });
        assert.ok(started); console.log('image verified');`
      assert.match(execFileSync(process.execPath, ["--input-type=module", "--eval", program], { encoding: "utf8", cwd: directory }), /image verified/)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
