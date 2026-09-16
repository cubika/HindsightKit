import { describe, expect, it } from "vitest";

import {
  evaluateEpisodeAssociationDataset,
  loadEpisodeAssociationDataset,
  renderEpisodeAssociationReport,
} from "@provenloop/evaluation";

describe("Work Episode association evaluation", () => {
  it("passes the versioned 24-pair quality dataset", async () => {
    const dataset = await loadEpisodeAssociationDataset();
    const report = evaluateEpisodeAssociationDataset(dataset);

    expect(dataset.cases).toHaveLength(24);
    expect(report).toMatchObject({
      datasetId: "work-episode-association",
      datasetVersion: 1,
      status: "pass",
      thresholds: {
        precision: 0.95,
        recall: 0.9,
      },
    });
    expect(report.metrics).toMatchObject({
      ambiguousCases: 4,
      falseNegatives: 0,
      falsePositives: 0,
      precision: 1,
      recall: 1,
      wrongMerges: 0,
      wrongSplits: 0,
    });
    expect(renderEpisodeAssociationReport(report)).toContain(
      "Wrong merges: 0",
    );
  });

  it("fails a dataset containing a wrong merge", async () => {
    const dataset = await loadEpisodeAssociationDataset();
    const failing = {
      ...dataset,
      cases: dataset.cases.map((testCase, index) =>
        index === 0
          ? {
              ...testCase,
              label: "different" as const,
            }
          : testCase,
      ),
    };
    const report = evaluateEpisodeAssociationDataset(failing);

    expect(report.status).toBe("fail");
    expect(report.metrics.wrongMerges).toBe(1);
    expect(report.metrics.precision).toBeLessThan(0.95);
  });

  it("fails when all labels are ambiguous", async () => {
    const dataset = await loadEpisodeAssociationDataset();
    const ambiguous = {
      ...dataset,
      cases: dataset.cases.map((testCase) => ({
        ...testCase,
        label: "ambiguous" as const,
      })),
    };
    const report = evaluateEpisodeAssociationDataset(ambiguous);

    expect(report).toMatchObject({
      status: "fail",
      metrics: {
        negativeCases: 0,
        positiveCases: 0,
        precision: 0,
        recall: 0,
        scoredCases: 0,
      },
    });
    expect(report.metrics.ambiguousForced).toBeGreaterThan(0);
    expect(renderEpisodeAssociationReport(report)).toContain(
      "Ambiguous cases forced to a decision:",
    );
  });
});
