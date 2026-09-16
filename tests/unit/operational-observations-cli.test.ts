import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "@provenloop/contracts";
import { runCli } from "@provenloop/cli";
import { recordLocalObservationBatch } from "../../packages/cli/src/observation-summary.js";
import { PROVENLOOP_CODE_VERSION } from "../../packages/cli/src/release-metadata.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

const output = () => {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    io: {
      log: (message: string) => { logs.push(message); },
      error: (message: string) => { errors.push(message); },
    },
  };
};

describe("observational CLI routes", () => {
  it("shows and exports real local observations without asserting controlled benefit", async () => {
    const dataRoot = await mkdtemp(join(process.cwd(), ".r4-observations-"));
    directories.push(dataRoot);
    await recordLocalObservationBatch({
      dataRoot,
      contextUseRecords: [{
        schemaVersion: CURRENT_SCHEMA_VERSION,
        appliedKnowledgeIds: [],
        candidateKnowledgeIds: ["rule-one"],
        codeVersion: PROVENLOOP_CODE_VERSION,
        createdAt: "2026-09-05T01:00:00.000Z",
        latencyMs: 10,
        renderedTokens: 30,
        repoId: "repo-one",
        requestId: "request-one",
        retrievalStatus: "provided",
        returnedKnowledgeIds: ["knowledge:rule-one"],
        sessionId: "sdk-session-one",
      }],
    });
    const common = [
      "--date", "2026-09-05",
      "--session", "sdk-session-one",
      "--data-root", dataRoot,
    ];
    const shown = output();
    expect(await runCli(["observations", "show", ...common], shown.io)).toBe(0);
    expect(JSON.parse(shown.logs[0] ?? "[]")).toEqual([
      expect.objectContaining({
        evidenceKind: "observational",
        controlledEffect: "not_established",
        outcome: "unknown",
        retrieval: expect.objectContaining({ invocationCount: 1, explicitlyAdoptedCount: 0 }),
      }),
    ]);
    expect(shown.logs[0]).not.toContain("sdk-session-one");
    const exported = output();
    expect(await runCli(["observations", "export", ...common], exported.io)).toBe(0);
    expect(JSON.parse(exported.logs[0] ?? "{}")).toMatchObject({
      evidenceKind: "observational",
      controlledEffect: "not_established",
      codeVersion: PROVENLOOP_CODE_VERSION,
      observations: [expect.objectContaining({ invocationCount: 1, outcome: "unknown" })],
    });
  });

  it("rejects invalid selectors and file output instead of accepting unsafe or ignored arguments", async () => {
    for (const args of [
      ["observations", "show", "--date", "..\\outside"],
      ["observations", "show", "--date", "2026-02-31"],
      ["observations", "show", "--session", "   "],
      ["observations", "export", "--out", "outside.json"],
      ["observations", "export", "--date"],
      ["observations", "show", "--session", "one", "--session", "two"],
    ]) {
      const result = output();
      expect(await runCli(args, result.io)).toBe(2);
      expect(result.logs).toEqual([]);
      expect(result.errors[0]).toContain("not controlled benefit");
    }
  });
});
