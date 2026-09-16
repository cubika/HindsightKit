import {
  existsSync,
} from "node:fs";
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
  runMvpReleaseGate,
} from "@provenloop/evaluation";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-mvp-gate-"),
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

describe("M1 + M2 MVP aggregate release gate", () => {
  it(
    "publishes a reproducible No-Go with all automated subgates",
    async () => {
      const outputRoot = await createTemporaryDirectory();
      const runId = "mvp-test-run";
      const result = await runMvpReleaseGate({
        codeVersion: "test-code-version",
        outputRoot,
        releaseTarget: "stable",
        runId,
      });

    expect(result.report).toMatchObject({
      codeVersion: "test-code-version",
      decision: "no_go",
      exitCode: 1,
      releaseTarget: "stable",
    });
    expect(result.report.subgates).toHaveLength(3);
    expect(result.report.checks.find((check) => check.checkId === "automatic-learning-acceptance")?.status).toBe("blocked");
    expect(result.report.checks.filter((check) => check.checkId.startsWith("M2-AUTO-")))
      .toHaveLength(8);
    expect(result.report.evaluationBinding).toMatchObject({
      codeVersion: "test-code-version",
      datasets: {
        branchContinuation: {
          datasetVersion: 1,
        },
        correctionRecurrence: {
          datasetVersion: 1,
        },
        workEpisodeAssociation: {
          datasetVersion: 1,
        },
      },
    });
    expect(
      result.report.subgates.map((subgate) => subgate.subgate),
    ).toEqual([
      "m0",
      "m1",
      "m2",
    ]);
    expect(
      result.report.checks.find(
        (check) => check.checkId === "m0-observation-foundation",
      )?.status,
    ).toBe("blocked");
    expect(
      result.report.checks.find(
        (check) => check.checkId === "worst-case-review",
      )?.status,
    ).toBe("blocked");
    expect(
      JSON.parse(
        await readFile(
          join(result.runDirectory, "mvp-report.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      decision: "no_go",
    });
    expect(
      await readFile(
        join(result.runDirectory, "mvp-report.md"),
        "utf8",
      ),
    ).toContain("M1 + M2 MVP Go/No-Go");
    for (const subgate of result.report.subgates) {
      expect(
        await readFile(
          join(result.runDirectory, subgate.reportPath),
          "utf8",
        ),
      ).toContain('"reportVersion": 1');
    }
    expect(
      existsSync(join(outputRoot, `.${runId}.staging`)),
    ).toBe(false);

    const repeated = await runMvpReleaseGate({
      codeVersion: "test-code-version",
      outputRoot,
      releaseTarget: "stable",
      runId: "mvp-repeat-run",
    });
    expect(
      repeated.report.subgates.map(
        (subgate) => subgate.evidenceDigest,
      ),
    ).toEqual(
      result.report.subgates.map(
        (subgate) => subgate.evidenceDigest,
      ),
    );
    expect(repeated.report.evaluationBinding).toEqual(
      result.report.evaluationBinding,
    );

      await expect(
        runMvpReleaseGate({
          codeVersion: "test-code-version",
          outputRoot,
          runId,
        }),
      ).rejects.toMatchObject({
        code: "EEXIST",
      });
    },
    // Three aggregate evaluations share this fixture; gate assertions and product budgets are unchanged.
    45_000,
  );

  it("publishes a path-free invalid-evidence report", async () => {
    const outputRoot = await createTemporaryDirectory();
    const evidencePath = join(outputRoot, "missing-evidence.json");
    const result = await runMvpReleaseGate({
      codeVersion: "test-code-version",
      evidencePath,
      outputRoot,
      runId: "mvp-invalid-evidence",
    });
    const json = await readFile(
      join(result.runDirectory, "mvp-report.json"),
      "utf8",
    );

    expect(result.report).toMatchObject({
      decision: "no_go",
      exitCode: 2,
      subgates: [],
    });
    expect(json).not.toContain(outputRoot);
  });

  it("rejects an unignored output directory inside the repository", async () => {
    const outputRoot = join(
      process.cwd(),
      "mvp-unignored-output-test",
    );

    await expect(
      runMvpReleaseGate({
        codeVersion: "test-code-version",
        outputRoot,
        runId: "mvp-invalid-output",
      }),
    ).rejects.toThrow(
      "MVP output directory must be outside the repository or ignored by Git.",
    );
    expect(existsSync(outputRoot)).toBe(false);
  });

  it(
    "uses repository-root provenance from a nested working directory",
    async () => {
      const outputRoot = await createTemporaryDirectory();
      const root = await runMvpReleaseGate({
        cwd: process.cwd(),
        outputRoot,
        runId: "mvp-root-provenance",
      });
      const nested = await runMvpReleaseGate({
        cwd: join(process.cwd(), "packages"),
        outputRoot,
        runId: "mvp-nested-provenance",
      });

      expect(nested.report.codeVersion).toBe(
        root.report.codeVersion,
      );
      expect(nested.report.evaluationBinding).toEqual(
        root.report.evaluationBinding,
      );
    },
    30_000,
  );
});
