import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "eval/**/*.test.ts"],
    environment: "node",
  },
});
