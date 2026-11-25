import { defineConfig } from "vitest/config";
import codspeedPlugin from "@codspeed/vitest-plugin";

// Benchmarks only (`npm run bench`); the test suite runs on node:test.
export default defineConfig({
  plugins: [codspeedPlugin()],
  test: {
    benchmark: {
      include: ["benchmarks/**/*.bench.js"],
    },
  },
});
