import { defineConfig } from "vitest/config";

export default defineConfig({ test: {
  environment: "node",
  include: ["specs/sso-oidc-redirect.e2e.test.ts"],
  testTimeout: 300_000,
} });
