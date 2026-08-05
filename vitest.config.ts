import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/shared/**", "src/extension/sensors/**", "src/extension/enrichment-store.ts", "src/mcp-server/**"],
      thresholds: {
        lines: 60,
      },
    },
  },
  resolve: {
    alias: {
      "@": "./src",
    },
  },
});
