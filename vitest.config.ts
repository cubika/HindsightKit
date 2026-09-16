import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

const packageSource = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

const sourceRuntimeTests = [
  "tests/unit/production-learning-loop.test.ts",
  "tests/unit/mcp-registry-runtime.test.ts",
];
const nativeProcessTests = [
  "tests/unit/installer-runtime.test.ts",
  "tests/unit/installer-integration.test.ts",
  "tests/unit/owned-processes.test.ts",
  "tests/unit/legacy-extension-workers.test.ts",
  "tests/unit/refresh-plugin-files.test.ts",
];

export default defineConfig({
  resolve: {
    alias: {
      "@provenloop/cli": packageSource("cli"),
      "@provenloop/contracts": packageSource("contracts"),
      "@provenloop/copilot-adapter": packageSource("copilot-adapter"),
      "@provenloop/domain": packageSource("domain"),
      "@provenloop/evaluation": packageSource("evaluation"),
      "@provenloop/host": packageSource("host"),
      "@provenloop/platform-windows": packageSource("platform-windows"),
      "@provenloop/retrieval": packageSource("retrieval"),
      "@provenloop/storage-sqlite": packageSource("storage-sqlite"),
      "@provenloop/testkit": packageSource("testkit"),
    },
  },
  test: {
    hookTimeout: 30_000,
    // Bound process startup contention without relaxing foreground runtime deadlines.
    maxWorkers: 4,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          exclude: [
            ...configDefaults.exclude, ...sourceRuntimeTests, ...nativeProcessTests,
          ],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "source-runtime",
          include: sourceRuntimeTests,
          // Run native-runtime functional checks after CPU-heavy tests, not alongside them.
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: "native-process",
          include: nativeProcessTests,
          // Native compiler/process handshakes must not race the CPU-heavy suites.
          fileParallelism: false,
          sequence: { groupOrder: 2 },
        },
      },
    ],
    testTimeout: 30_000,
  },
});
