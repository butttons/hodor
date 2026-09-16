import { defineConfig } from "vitest/config";

// Plain node environment — specs are pure unit tests and don't import
// `cloudflare:test`. If worker-integration tests are added later, scope a
// workerd-pool config to those files instead of wrapping everything here.
export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.spec.ts"],
  },
});
