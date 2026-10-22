import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

// Opt-in published-version upgrade lab, not the ordinary PR or desktop suite.
export default defineConfig({
  resolve: { alias: [{ find: /^@openwork\/testkit$/, replacement: fileURLToPath(new URL("./packages/testkit/src/index.ts", import.meta.url)) }] },
  test: { name: "den-super-admin-upgrade", environment: "node", fileParallelism: false, maxWorkers: 1, testTimeout: 600_000,
    include: ["specs/den-super-admin-preservation.test.ts"] },
})
