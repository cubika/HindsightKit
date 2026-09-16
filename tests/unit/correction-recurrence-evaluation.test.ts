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
  vi,
} from "vitest";

import {
  correctionRecurrenceDatasetSchema,
  evaluateCorrectionRecurrenceDataset,
  loadCorrectionRecurrenceDataset,
  renderCorrectionRecurrenceReport,
} from "@provenloop/evaluation";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";

const temporaryDirectories: string[] = [];

const createEvaluationPaths = async (): Promise<{
  readonly databasePath: string;
  readonly knowledgeDatabasePath: string;
}> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-correction-recurrence-"),
  );
  temporaryDirectories.push(directory);
  return {
    databasePath: join(directory, "canonical.db"),
    knowledgeDatabasePath: join(directory, "knowledge.db"),
  };
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

describe("Correction Recurrence evaluation", () => {
  it("passes the frozen 24-Opportunity M2 dataset", async () => {
    const dataset = await loadCorrectionRecurrenceDataset();
    const report = await evaluateCorrectionRecurrenceDataset(
      dataset,
      await createEvaluationPaths(),
    );

    expect(dataset.opportunities).toHaveLength(24);
    expect(report).toMatchObject({
      datasetId: "correction-recurrence",
      datasetVersion: 1,
      evidenceKind: "synthetic",
      evaluationPurpose: "regression",
      fieldEffect: "not_established",
      status: "pass",
      thresholds: {
        evidenceTierAccuracy: 0.95,
        minimumOpportunities: 20,
        provenanceCompleteness: 1,
        rcrImprovement: 0.2,
        wrongInjectionRate: 0.02,
      },
    });
    expect(report.metrics).toMatchObject({
      baselineCorrectionRepeated: 12,
      caseCount: 30,
      contextCorrectionRepeated: 4,
      counterevidenceCases: 2,
      counterevidenceStopped: 2,
      degradedRetrievals: 0,
      evidenceTierAccuracy: 1,
      evidenceTierCaseCount: 30,
      matchedCases: 30,
      negativeCaseCount: 6,
      opportunityCount: 24,
      provenanceCompleteness: 1,
      wrongInjections: 0,
    });
    expect(
      [
        ...report.opportunities,
        ...report.negativeCases,
      ].every(
        (result) => result.unexpectedKnowledgeIds.length === 0,
      ),
    ).toBe(true);
    expect(
      report.opportunities.every(
        (result) =>
          !result.baselineKnowledgeAppliedBeforeCorrection &&
          result.contextKnowledgeAppliedBeforeCorrection,
      ),
    ).toBe(true);
    expect(report.metrics.baselineRcr).toBeCloseTo(0.5);
    expect(report.metrics.contextRcr).toBeCloseTo(1 / 6);
    expect(report.metrics.rcrImprovement).toBeCloseTo(2 / 3);
    expect(renderCorrectionRecurrenceReport(report)).toContain(
      "RCR improvement: 66.67%",
    );
  });

  it.each(["binding", "operation"] as const)(
    "rejects a replay that loses its verification %s in canonical storage",
    async (missing) => {
      const original = CanonicalSqliteStore.prototype.episodeSourceEnvelopes;
      vi.spyOn(CanonicalSqliteStore.prototype, "episodeSourceEnvelopes")
        .mockImplementation(function (this: CanonicalSqliteStore) {
          const records = original.call(this);
          return missing === "operation"
            ? records.filter((record) => record.event.eventType !== "tool.started")
            : records.map((record) => ({
              ...record,
              event: { ...record.event, verificationBinding: undefined },
            }));
        });
      await expect(evaluateCorrectionRecurrenceDataset(
        await loadCorrectionRecurrenceDataset(),
        await createEvaluationPaths(),
      )).rejects.toThrow("Synthetic correction proof did not survive canonical storage");
    },
  );

  it("rejects relabeling the synthetic corpus as field evidence", async () => {
    const dataset = await loadCorrectionRecurrenceDataset();
    expect(() => correctionRecurrenceDatasetSchema.parse({
      ...dataset,
      evidenceKind: "observational",
    })).toThrow();
  });

  it("fails when Correction Recurrence does not improve", async () => {
    const dataset = await loadCorrectionRecurrenceDataset();
    const failing = {
      ...dataset,
      opportunities: dataset.opportunities.map((testCase) => ({
        ...testCase,
        contextTrace: testCase.baselineTrace,
      })),
    };
    const report = await evaluateCorrectionRecurrenceDataset(
      failing,
      await createEvaluationPaths(),
    );

    expect(report.status).toBe("fail");
    expect(report.metrics.rcrImprovement).toBe(0);
  });

  it("rejects datasets with fewer than 20 independent Opportunities", async () => {
    const dataset = await loadCorrectionRecurrenceDataset();

    expect(() =>
      correctionRecurrenceDatasetSchema.parse({
        ...dataset,
        opportunities: dataset.opportunities.slice(0, 19),
      }),
    ).toThrow();
  });

  it("rejects case IDs that collide after correction identity normalization", async () => {
    const dataset = await loadCorrectionRecurrenceDataset();

    expect(() =>
      correctionRecurrenceDatasetSchema.parse({
        ...dataset,
        opportunities: dataset.opportunities.map(
          (testCase, index) =>
            index === 1
              ? {
                  ...testCase,
                  caseId:
                    dataset.opportunities[0]?.caseId.toUpperCase(),
                }
              : testCase,
        ),
      }),
    ).toThrow("unique after identity normalization");
  });

  it("rejects identifiers that could inject Markdown", async () => {
    const dataset = await loadCorrectionRecurrenceDataset();

    expect(() =>
      correctionRecurrenceDatasetSchema.parse({
        ...dataset,
        opportunities: dataset.opportunities.map(
          (testCase, index) =>
            index === 0
              ? {
                  ...testCase,
                  caseId: "case|![remote](https://example.invalid)",
                }
              : testCase,
        ),
      }),
    ).toThrow("Evaluation identifiers");
  });

  it("requires every fail-closed negative scenario", async () => {
    const dataset = await loadCorrectionRecurrenceDataset();

    expect(() =>
      correctionRecurrenceDatasetSchema.parse({
        ...dataset,
        negativeCases: dataset.negativeCases.filter(
          (testCase) => testCase.scenario !== "scope_mismatch",
        ),
      }),
    ).toThrow("requires a scope_mismatch negative case");
  });

  it("counts any unexpected returned Knowledge as Wrong Injection", async () => {
    const dataset = await loadCorrectionRecurrenceDataset();
    const adversarial = {
      ...dataset,
      negativeCases: dataset.negativeCases.map((testCase) =>
        testCase.caseId === "negative-scope-01"
          ? {
              ...testCase,
              queryCaseId: "negative-scope-02",
            }
          : testCase,
      ),
    };
    const report = await evaluateCorrectionRecurrenceDataset(
      adversarial,
      await createEvaluationPaths(),
    );

    expect(report.status).toBe("fail");
    expect(report.metrics.wrongInjections).toBe(1);
    expect(report.metrics.wrongInjectionRate).toBeCloseTo(1 / 30);
    expect(
      report.negativeCases
        .find((testCase) => testCase.caseId === "negative-scope-01")
        ?.unexpectedKnowledgeIds,
    ).toHaveLength(1);
  });
});
