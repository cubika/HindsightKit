import {
  readFile,
} from "node:fs/promises";
import {
  resolve,
} from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const [
  version,
  evidenceDirectoryInput,
] = process.argv.slice(2);
if (!version || !evidenceDirectoryInput) {
  throw new Error(
    "Usage: node scripts/verify-release-evidence.mjs <version> <directory>",
  );
}

const repositoryRoot = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const evidenceDirectory = resolve(evidenceDirectoryInput);
const readJson = async (name) => {
  const content = await readFile(
    resolve(evidenceDirectory, name),
    "utf8",
  );
  return JSON.parse(content.replace(/^\uFEFF/u, ""));
};
const [
  rootPackage,
  cliPackage,
  m0Evidence,
  releaseEvidence,
  m0Report,
  mvpReport,
  releaseNotes,
] = await Promise.all([
  readJson(resolve(repositoryRoot, "package.json")),
  readJson(resolve(repositoryRoot, "packages", "cli", "package.json")),
  readJson("m0-evidence.json"),
  readJson("release-evidence.json"),
  readJson("m0-report.json"),
  readJson("mvp-report.json"),
  readFile(resolve(evidenceDirectory, "release-notes.md"), "utf8"),
]);

if (
  rootPackage.version !== version ||
  cliPackage.version !== version
) {
  throw new Error("Release version does not match package metadata.");
}
if (
  m0Report.status !== "pass" ||
  m0Report.exitCode !== 0 ||
  ![
    "go",
    "conditional_go",
  ].includes(mvpReport.decision) ||
  mvpReport.exitCode !== 0
) {
  throw new Error("Retained M0 or MVP release decision is not publishable.");
}
if (
  !isDeepStrictEqual(m0Evidence, m0Report.acceptanceEvidence) ||
  !isDeepStrictEqual(releaseEvidence, mvpReport.evidence)
) {
  throw new Error("Retained evidence does not match the release reports.");
}
const head = spawnSync(
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
if (head.status !== 0) {
  throw new Error(head.stderr || "Unable to resolve release commit.");
}
const commit = head.stdout.trim();
if (
  m0Report.codeVersion !== commit ||
  mvpReport.codeVersion !== commit
) {
  throw new Error("Release reports do not bind to the tagged commit.");
}
if (
  m0Report.runtimeDigest !== m0Evidence.binding?.runtimeDigest ||
  m0Evidence.binding?.pluginVersion !== version
) {
  throw new Error("M0 runtime or plugin evidence binding is invalid.");
}
if (releaseNotes.trim().length === 0) {
  throw new Error("Release notes must not be empty.");
}
if (
  process.env.GITHUB_REF_NAME &&
  process.env.GITHUB_REF_NAME !== `v${version}`
) {
  throw new Error("Git tag does not match the package version.");
}

console.log(
  `Verified release evidence for ${version} at ${commit}.`,
);
