import {
  cp,
  mkdir,
  readFile,
  rm,
} from "node:fs/promises";
import {
  dirname,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { build } from "esbuild";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliRoot = resolve(repositoryRoot, "packages", "cli");
const outputDirectory = resolve(cliRoot, "dist");
const fixtureDirectory = resolve(cliRoot, "fixtures");
const gitHead = spawnSync(
  "git",
  [
    "rev-parse",
    "HEAD",
  ],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  },
);
if (gitHead.status !== 0) {
  throw new Error(
    gitHead.stderr.trim() ||
      "Unable to resolve release Git version.",
  );
}
const gitStatus = spawnSync(
  "git",
  [
    "status",
    "--porcelain=v1",
  ],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  },
);
if (gitStatus.status !== 0) {
  throw new Error(
    gitStatus.stderr.trim() ||
      "Unable to inspect release Git status.",
  );
}
const codeVersion =
  `${gitHead.stdout.trim()}${
    gitStatus.stdout.trim().length === 0 ? "" : "-dirty"
  }`;
const releaseDefines = {
  __PROVENLOOP_CODE_VERSION__: JSON.stringify(codeVersion),
  __PROVENLOOP_PLUGIN_ASSETS__: JSON.stringify(Object.fromEntries(await Promise.all([
    "plugin.json", ".mcp.json", "extensions/event-capture/extension.mjs",
    "scripts/mcp-launcher.ps1", "skills/provenloop-context/SKILL.md",
  ].map(async (path) => [
    path,
    await readFile(resolve(repositoryRoot, "plugins", "provenloop", path), "utf8"),
  ])))),
};

await Promise.all([
  rm(outputDirectory, {
    force: true,
    recursive: true,
  }),
  rm(fixtureDirectory, {
    force: true,
    recursive: true,
  }),
]);
await mkdir(outputDirectory, {
  recursive: true,
});

await build({
  bundle: true,
  define: releaseDefines,
  entryPoints: {
    bin: resolve(cliRoot, "src", "bin.ts"),
    "extension-entry": resolve(cliRoot, "src", "extension-entry.ts"),
    index: resolve(cliRoot, "src", "index.ts"),
  },
  format: "esm",
  legalComments: "eof",
  logLevel: "info",
  mainFields: [
    "module",
    "main",
  ],
  outdir: outputDirectory,
  platform: "node",
  sourcemap: false,
  target: "node22",
  tsconfig: resolve(repositoryRoot, "tsconfig.base.json"),
});

await cp(
  resolve(repositoryRoot, "packages", "evaluation", "fixtures"),
  fixtureDirectory,
  {
    recursive: true,
  },
);
