import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  runM1ReleaseGate,
} from "@provenloop/evaluation";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-m1-gate-"),
  );
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("M1 aggregate release gate", () => {
  it("retains a passing research report and replay database", async () => {
    const outputRoot = await createTemporaryDirectory();
    const result = await runM1ReleaseGate({
      codeVersion: "test-code-version",
      outputRoot,
      runId: "m1-test-run",
    });

    expect(result.report).toMatchObject({
      codeVersion: "test-code-version",
      exitCode: 0,
      releaseTarget: "research",
      status: "pass",
      branchContinuation: {
        status: "pass",
      },
    });
    expect(result.report.checks).toHaveLength(8);
    expect(
      result.report.checks.every((check) => check.status === "pass"),
    ).toBe(true);
    expect(
      JSON.parse(
        await readFile(
          join(result.runDirectory, "m1-report.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      status: "pass",
    });
    expect(
      await readFile(
        join(result.runDirectory, "m1-report.md"),
        "utf8",
      ),
    ).toContain("Branch Continuation Evaluation");
    expect(
      await readFile(
        join(result.runDirectory, "branch-continuation.db"),
      ),
    ).not.toHaveLength(0);
  });

  it("supports the stable Wrong Injection threshold", async () => {
    const outputRoot = await createTemporaryDirectory();
    const result = await runM1ReleaseGate({
      codeVersion: "test-code-version",
      outputRoot,
      releaseTarget: "stable",
      runId: "m1-stable-run",
    });

    expect(result.report).toMatchObject({
      exitCode: 0,
      releaseTarget: "stable",
      status: "pass",
      branchContinuation: {
        thresholds: {
          wrongInjectionRate: 0.01,
        },
      },
    });
  });

  it("retains an infrastructure report when the dataset is unavailable", async () => {
    const outputRoot = await createTemporaryDirectory();
    const result = await runM1ReleaseGate({
      codeVersion: "test-code-version",
      datasetPath: join(outputRoot, "missing-dataset.json"),
      outputRoot,
      runId: "m1-failed-run",
    });

    expect(result.report).toMatchObject({
      exitCode: 3,
      status: "fail",
    });
    expect(result.report.branchContinuation).toBeUndefined();
    expect(
      await readFile(
        join(result.runDirectory, "m1-report.json"),
        "utf8",
      ),
    ).toContain('"exitCode": 3');
  });

  it("does not overwrite an earlier run", async () => {
    const outputRoot = await createTemporaryDirectory();
    await runM1ReleaseGate({
      codeVersion: "test-code-version",
      outputRoot,
      runId: "m1-existing-run",
    });

    await expect(
      runM1ReleaseGate({
        codeVersion: "test-code-version",
        outputRoot,
        runId: "m1-existing-run",
      }),
    ).rejects.toMatchObject({
      code: "EEXIST",
    });
  });
});
