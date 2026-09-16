import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

export const createCanonicalStoreWorkerModule = async (
  directory: string,
): Promise<string> => {
  const output = join(directory, "canonical-store-worker.mjs");
  // Native Workers cannot resolve TypeScript's emitted .js specifiers in source files.
  await build({
    bundle: true,
    entryPoints: [resolve("packages", "storage-sqlite", "src", "canonical-store.ts")],
    format: "esm",
    logLevel: "silent",
    outfile: output,
    platform: "node",
    target: "node22",
    tsconfig: resolve("tsconfig.base.json"),
  });
  return pathToFileURL(output).href;
};
