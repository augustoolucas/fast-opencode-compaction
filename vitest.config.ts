import { defineConfig } from "vitest/config";

/**
 * Test discovery is pinned to `src` so it can never wander into build output: `dist/` contains a
 * compiled copy of any test that slipped past the tsconfig exclusion, and running both copies makes
 * every test count twice.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
