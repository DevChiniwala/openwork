import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const denRequire = createRequire(new URL("../../ee/apps/den-web/package.json", import.meta.url));

// Isolated component/browser lane; never attaches to a running desktop or lab.
export default defineConfig({
  resolve: { alias: [
    { find: /^react$/, replacement: denRequire.resolve("react") },
    { find: /^react-dom\/server$/, replacement: denRequire.resolve("react-dom/server") },
  ] },
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["specs/sso-provider-values.test.ts", "specs/sso-provider-values.e2e.test.ts"],
    testTimeout: 300_000,
  },
});
