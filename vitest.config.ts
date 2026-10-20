import { defineConfig } from "vitest/config";

// One test run for the whole workspace. Package tests live in <package>/test/*.test.ts.
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    passWithNoTests: true,
  },
});
