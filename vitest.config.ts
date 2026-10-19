import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Test secrets are pinned here so the suite is hermetic: a developer's .dev.vars (real keys for local play)
// must never reach a test, and a test must never depend on it.
const TEST_SECRETS = {
  KALTRA_CRED_ANTHROPIC_MAIN: "test-anthropic-key",
  KALTRA_CRED_GRAPH_MAIN: "test-graph-client-secret",
  KALTRA_CRED_DEV_DOOR_SECRET: "dev-door-test-secret",
  KALTRA_OUTPOST_PRIVATE_KEY: "MC4CAQAwBQYDK2VwBCIEIFER62QDnH7g1UOjS9QhSOCP5A-JaSqlNRNm5XbQMHPd",
  KALTRA_ACCESS_AUD: "",
};

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: { bindings: TEST_SECRETS },
    }),
  ],
});
