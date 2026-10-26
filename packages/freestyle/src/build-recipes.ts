import { readFileSync } from "node:fs";
import type { PreviewWorld } from "./index.ts";
import { browserRecipe } from "./browser-recipe.ts";

type OpencodeV2Artifact = { url: string; integrity: string };

function opencodeV2Artifact(manifest: unknown, key: string): OpencodeV2Artifact {
  const platforms = typeof manifest === "object" && manifest !== null && "platforms" in manifest ? manifest.platforms : null;
  const entry = typeof platforms === "object" && platforms !== null && key in platforms ? Reflect.get(platforms, key) : null;
  const url = typeof entry === "object" && entry !== null && "url" in entry ? entry.url : null;
  const integrity = typeof entry === "object" && entry !== null && "integrity" in entry ? entry.integrity : null;
  if (typeof url !== "string" || !/^https:\/\/registry\.npmjs\.org\//.test(url) || typeof integrity !== "string" || !/^sha512-[A-Za-z0-9+/=]+$/.test(integrity)) {
    throw new Error(`No verified OpenCode v2 artifact for ${key}`);
  }
  return { url, integrity };
}

/**
 * Bakes the server's pinned, integrity-checked OpenCode v2 into the shared
 * tools layer (as `opencode2` on PATH, the server's second resolution step),
 * so a preview never downloads its engine at boot. The URL and integrity are
 * part of the recipe text, so a new pin builds a new tools layer.
 */
export function opencodeV2Recipe(): string {
  const manifest: unknown = JSON.parse(readFileSync(new URL("../../../apps/server/src/opencode-v2-artifacts.json", import.meta.url), "utf8"));
  const x64 = opencodeV2Artifact(manifest, "linux-x64-baseline");
  const arm64 = opencodeV2Artifact(manifest, "linux-arm64");
  return `case "$(uname -m)" in
  x86_64|amd64) opencode2_url='${x64.url}'; opencode2_integrity='${x64.integrity}' ;;
  aarch64|arm64) opencode2_url='${arm64.url}'; opencode2_integrity='${arm64.integrity}' ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
opencode2_tmp="$(mktemp -d)"
node --input-type=module -e 'import { createHash } from "node:crypto"; import { writeFileSync } from "node:fs"; const [url, integrity, target] = process.argv.slice(1); const response = await fetch(url); if (!response.ok) throw new Error("OpenCode v2 download failed: " + response.status); const bytes = Buffer.from(await response.arrayBuffer()); if ("sha512-" + createHash("sha512").update(bytes).digest("base64") !== integrity) throw new Error("OpenCode v2 archive integrity mismatch"); writeFileSync(target, bytes)' "$opencode2_url" "$opencode2_integrity" "$opencode2_tmp/opencode2.tgz"
tar -xzf "$opencode2_tmp/opencode2.tgz" -C "$opencode2_tmp" package/bin/opencode
install -m 0755 "$opencode2_tmp/package/bin/opencode" /usr/local/bin/opencode2
rm -rf "$opencode2_tmp"
/usr/local/bin/opencode2 --version`;
}

/** Workbot's VM runs Den on its own MySQL/Redis, the runner and Workbot: no desktop, browser or OpenCode. */
const WORKBOT_TOOLS = `corepack enable
corepack prepare pnpm@11.4.0 --activate
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-server redis-server
systemctl enable --now mysql redis-server
mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'password'; FLUSH PRIVILEGES;"
mkdir -p /opt/openwork-preview/tools`;

export function toolsRecipe(world: PreviewWorld): string {
  if (world === "workbot") return WORKBOT_TOOLS;
  return `${world === "desktop" ? `node -e 'if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Desktop previews require Node 24 or newer")'
export COREPACK_HOME=/opt/openwork-preview/corepack
` : ""}corepack enable
corepack prepare pnpm@11.4.0 --activate${world === "desktop" ? "\ncorepack prepare pnpm@10.27.0" : ""}
${world !== "app-web" ? `apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ${world === "acme-web" ? "mysql-server redis-server " : "build-essential python3 curl ca-certificates "}xvfb x11vnc novnc websockify dbus-x11 xauth libgtk-3-0 libnss3 libasound2t64 libgbm1
# A real Linux desktop (as in Daytona previews): panel, window frames, terminal, files.
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-settings xfce4-terminal thunar
${browserRecipe()}
printf '<!doctype html><meta http-equiv="refresh" content="0; url=vnc.html?autoconnect=1&amp;resize=scale&amp;reconnect=1&amp;reconnect_delay=2000"><title>OpenWork desktop</title>' > /usr/share/novnc/index.html
${world === "acme-web" ? `systemctl enable --now mysql redis-server
mysql -e "ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'password'; FLUSH PRIVILEGES;"` : ""}` : ""}
mkdir -p /opt/openwork-preview/tools
${opencodeV2Recipe()}${world === "desktop" ? `
printf 'allowBuilds:\\n  bun: true\\n' > /opt/openwork-preview/tools/pnpm-workspace.yaml
pnpm --dir /opt/openwork-preview/tools add bun@1.3.14
node /opt/openwork-preview/tools/node_modules/bun/install.js
/opt/openwork-preview/tools/node_modules/.bin/bun --version` : ""}`;
}

export function dependencyRecipe(world: PreviewWorld): string {
  if (world === "workbot") {
    return `# Only manifests/config/patches remain when we install this reusable layer.
# No application lifecycle scripts or pnpm hooks may mutate the shared cache.
pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --filter @openwork/world... --filter @openwork-ee/den-api... --filter @openwork-ee/den-web... --filter @openwork-ee/headless-runner... --filter @openwork-ee/workbot...
pnpm --config.ignore-pnpmfile=true rebuild esbuild better-sqlite3 sharp @sentry/cli
pnpm --dir evals install --frozen-lockfile --ignore-scripts --ignore-pnpmfile`;
  }
  return `${world === "desktop" ? "export COREPACK_HOME=/opt/openwork-preview/corepack\n" : ""}# Only manifests/config/patches remain when we install this reusable layer.
# No application lifecycle scripts or pnpm hooks may mutate the shared cache.
pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --filter @openwork/app... --filter openwork-server... ${world === "desktop" ? "--filter @openwork/desktop..." : "--filter @openwork/world..."} ${world === "acme-web" ? "--filter @openwork-ee/den-api... --filter @openwork-ee/den-web... --filter @openwork-ee/gateway... --filter @openwork/desktop..." : ""}
pnpm --config.ignore-pnpmfile=true rebuild esbuild better-sqlite3 sharp node-pty electron @sentry/cli @whiskeysockets/baileys protobufjs
${world === "acme-web" ? "pnpm --dir evals install --frozen-lockfile --ignore-scripts --ignore-pnpmfile" : ""}`;
}

export function checkoutRecipe(sha: string): string {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("A full pushed commit SHA is required.");
  return `git init /workspace
cd /workspace
git config core.hooksPath /dev/null
git remote remove origin 2>/dev/null || true
git remote add origin https://github.com/different-ai/openwork.git
git fetch --depth=1 origin ${sha}
git checkout --force --detach FETCH_HEAD
git clean -ffdx -e node_modules/
test "$(git rev-parse HEAD)" = "${sha}"`;
}

export function compiledRecipe(world: PreviewWorld): string {
  if (world === "workbot") {
    return `pnpm --filter @openwork-ee/den-api run build:workspace-dependencies
pnpm --filter @openwork-ee/workbot build
${ARCHIVE_COMPILED}`;
  }
  return `${world === "desktop" ? `export COREPACK_HOME=/opt/openwork-preview/corepack
export PATH="/opt/openwork-preview/tools/node_modules/.bin:$PATH"
node --input-type=module -e 'await import("./evals/packages/cdp/src/index.ts")'
` : ""}${world !== "app-web" ? `
(node apps/desktop/scripts/prepare-sidecar.mjs --force --outdir apps/desktop/resources/sidecars && node apps/desktop/scripts/prepare-computer-use-helper.mjs --force --outdir apps/desktop/resources/helpers) &
DESKTOP_BUILD=$!
${world === "acme-web" ? "pnpm --filter @openwork-ee/den-api run build:workspace-dependencies" : "pnpm --filter @openwork/headless-threads build"}
pnpm --filter @openwork/computer-use build
pnpm --filter openwork-server build
wait "$DESKTOP_BUILD"
` : "pnpm --filter @openwork/types build\npnpm --filter @openwork/enterprise-mcp-client build"}
${world === "desktop" ? "pnpm --filter @openwork/desktop rebuild:electron-native" : ""}
${ARCHIVE_COMPILED}`;
}

// Kept byte-for-byte as before: the compiled layer's cache key is a digest of this recipe text.
const ARCHIVE_COMPILED = `# Archive generated workspace output only; runtime databases and credentials do not exist yet.
node --input-type=module - <<'NODE'
import { readdirSync, existsSync, writeFileSync } from 'node:fs';
const paths = [];
for (const root of ['packages', 'ee/packages', 'apps', 'ee/apps']) {
  for (const dir of readdirSync(root)) {
    const path = root + '/' + dir + '/dist';
    if (existsSync(path)) paths.push(path);
  }
}
for (const path of ['apps/desktop/resources/sidecars', 'apps/desktop/resources/helpers']) {
  if (existsSync(path)) paths.push(path);
}
writeFileSync('/opt/openwork-preview/compiled-files', paths.join('\\0') + '\\0');
NODE
tar --null -T /opt/openwork-preview/compiled-files -cf /opt/openwork-preview/compiled.tar`;
