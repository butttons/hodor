import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Plain node environment — specs are pure unit tests and don't import
// `cloudflare:test`. If worker-integration tests are added later, scope a
// workerd-pool config to those files instead of wrapping everything here.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    include: ["src/**/__tests__/**/*.spec.ts"],
  },
});
