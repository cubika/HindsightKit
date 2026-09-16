import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { loadObservationManifest, observationManifestSchema, runM1ReleaseGate } from "@provenloop/evaluation";
import { verifyExternalReportArtifacts } from "../../packages/evaluation/src/external-report-binding.js";

const directories: string[] = [];
const root = async () => {
  const base = join(process.cwd(), "evaluation-output", "evidence-tests");
  await mkdir(base, { recursive: true });
  const path = await mkdtemp(join(base, "run-"));
  directories.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("observation evidence boundaries", () => {
  it("accepts bounded version-bound observations without promoting them to controlled effects", async () => {
    const directory = await root();
    const path = join(directory, "observations.json");
    const manifest = {
      schemaVersion: 1,
      evidenceKind: "observational",
      controlledEffect: "not_established",
      codeVersion: "test-code-version",
      observations: [{
        date: "2026-09-05", sessionDigest: "a".repeat(64), repoDigest: null,
        codeVersion: "test-code-version", invocationCount: null, providedCount: 0,
        explicitlyAdoptedCount: 0, observedCorrectionCount: 0,
        noMatchCount: 0, feedbackCount: 0, unknownStatusRecordCount: 0, retrievalState: "not_observed",
        verificationSucceededCount: null, verificationFailedCount: null,
        subsequentCorrectionCount: null, outcome: "unknown", coverage: "observed_records",
      }],
    };
    await writeFile(path, JSON.stringify(manifest));
    expect(await loadObservationManifest(path, "test-code-version")).toEqual(manifest);
    const evaluated = await runM1ReleaseGate({
      codeVersion: "test-code-version", outputRoot: directory,
      observationManifestPath: path, runId: "observational-regression",
    });
    expect(evaluated.report).toMatchObject({
      status: "pass", evidenceKind: "synthetic", evaluationPurpose: "regression",
      observationEvidence: manifest,
      branchContinuation: { evidenceKind: "synthetic", fieldEffect: "not_established" },
    });
    await expect(loadObservationManifest(path, "another-version")).rejects.toThrow("different code version");
    expect(() => observationManifestSchema.parse({ ...manifest, controlledEffect: "established" })).toThrow();
    expect(() => observationManifestSchema.parse({ ...manifest, prompt: "not permitted" })).toThrow();
  });

  it("reads each external artifact rather than trusting a repeated digest assertion", async () => {
    const directory = await root();
    const bytes = JSON.stringify({ measuredSamples: 500 });
    const digest = createHash("sha256").update(bytes).digest("hex");
    const path = join(directory, "capture.json");
    await writeFile(path, bytes);
    await expect(verifyExternalReportArtifacts(
      [{ path: "capture.json", sha256: digest }], [digest], directory,
    )).resolves.toBeUndefined();
    await writeFile(path, JSON.stringify({ measuredSamples: 0 }));
    await expect(verifyExternalReportArtifacts(
      [{ path: "capture.json", sha256: digest }], [digest], directory,
    )).rejects.toThrow("does not match");
    await expect(verifyExternalReportArtifacts(
      [{ path: "..\\outside.json", sha256: digest }], [digest], directory,
    )).rejects.toThrow("invalid");
    await expect(verifyExternalReportArtifacts([], [digest], directory)).rejects.toThrow("required");
  });
});
