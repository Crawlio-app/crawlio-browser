import { defineConfig } from "vitest/config";

// DOM-dependent primitives (xpath, inspectionView, registry) are exercised
// against a real DOM via jsdom. Each test file also carries a
// `// @vitest-environment jsdom` docblock so the env is correct regardless of
// the cwd vitest is invoked from.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
  },
});
