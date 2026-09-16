import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const packageNames = [
  "cli",
  "contracts",
  "copilot-adapter",
  "domain",
  "evaluation",
  "host",
  "platform-windows",
  "storage-sqlite",
  "testkit",
];

const targets = [
  resolve("coverage"),
  ...packageNames.map((name) => resolve("packages", name, "dist")),
];

await Promise.all(
  targets.map((target) =>
    rm(target, {
      force: true,
      recursive: true,
    }),
  ),
);
