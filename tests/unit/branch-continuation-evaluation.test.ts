import {
  mkdtemp,
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
  evaluateBranchContinuationDataset,
  loadBranchContinuationDataset,
  renderBranchContinuationReport,
} from "@provenloop/evaluation";

const temporaryDirectories: string[] = [];

const createDatabasePath = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-branch-continuation-"),
  );
  temporaryDirectories.push(directory);
  return join(directory, "evaluation.db");
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

describe("Branch Continuation evaluation", () => {
  it("passes the frozen 32-pair M1 dataset", async () => {
    const dataset = await loadBranchContinuationDataset();
    const report = await evaluateBranchContinuationDataset(
      dataset,
      {
        databasePath: await createDatabasePath(),
      },
    );

    expect(dataset.cases).toHaveLength(32);
    expect(report).toMatchObject({
      datasetId: "branch-continuation",
      datasetVersion: 1,
      status: "pass",
      thresholds: {
        latencyP95Ms: 150,
        minimumPairs: 30,
        outcomeSuccessDelta: -0.02,
        precisionAt3: 0.9,
        repeatedContextTokenMedianReduction: 0.3,
        ttvMedianReduction: 0.15,
        wrongInjectionRate: 0.02,
      },
    });
    expect(report.metrics).toMatchObject({
      caseCount: 32,
      degradedRetrievals: 0,
      matchedCases: 32,
      missedUsefulContexts: 0,
      negativeCases: 9,
      positiveCases: 23,
      precisionAt3: 1,
      tokenBudgetViolations: 0,
      wrongInjections: 0,
    });
    expect(
      report.metrics.repeatedContextTokenMedianReduction,
    ).toBeCloseTo(0.4);
    expect(report.metrics.ttvMedianReduction).toBeCloseTo(0.2);
    expect(report.metrics.latencyP95Ms).toBeLessThanOrEqual(150);
    expect(renderBranchContinuationReport(report)).toContain(
      "Retrieval Precision@3: 100.00%",
    );
  });

  it("fails when a returned Branch Context is labeled irrelevant", async () => {
    const dataset = await loadBranchContinuationDataset();
    const failing = {
      ...dataset,
      cases: dataset.cases.map((testCase, index) =>
        index === 0
          ? {
              ...testCase,
              expectedRelevant: false,
            }
          : testCase,
      ),
    };
    const report = await evaluateBranchContinuationDataset(
      failing,
      {
        databasePath: await createDatabasePath(),
      },
    );

    expect(report.status).toBe("fail");
    expect(report.metrics.wrongInjections).toBe(1);
    expect(report.metrics.wrongInjectionRate).toBeGreaterThan(0.02);
  });

  it("does not treat matching branch and HEAD as permission to continue a new task", async () => {
    const dataset = await loadBranchContinuationDataset();
    const report = await evaluateBranchContinuationDataset({
      ...dataset,
      cases: dataset.cases.map((testCase, index) => index === 0 ? {
        ...testCase, scenario: "new_task" as const, expectedRelevant: false,
      } : testCase),
    }, { databasePath: await createDatabasePath() });

    expect(report.status).toBe("pass");
    expect(report.cases[0]).toMatchObject({ scenario: "new_task", returnedContextIds: [], matched: true });
    expect(report.metrics.wrongInjections).toBe(0);
  });

  it("fails when product benefit or Outcome Success regresses", async () => {
    const dataset = await loadBranchContinuationDataset();
    const failing = {
      ...dataset,
      observations: {
        ...dataset.observations,
        applicableContext: {
          outcomeSucceeded: false,
          repeatedContextTokens:
            dataset.observations.baseline.repeatedContextTokens,
          ttvMs: dataset.observations.baseline.ttvMs,
        },
      },
    };
    const report = await evaluateBranchContinuationDataset(
      failing,
      {
        databasePath: await createDatabasePath(),
      },
    );

    expect(report.status).toBe("fail");
    expect(
      report.metrics.repeatedContextTokenMedianReduction,
    ).toBe(0);
    expect(report.metrics.outcomeSuccessDelta).toBeLessThan(-0.02);
  });
});
