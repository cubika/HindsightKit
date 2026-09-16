import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DuplicateLedgerEntryError,
  EvidenceLedgerWriter,
  loadEvaluationReport,
  regenerateMarkdownReport,
  runEvaluation,
} from "@provenloop/evaluation";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "provenloop-eval-test-"));
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

const expectedBuiltInResults = [
  ["valid-supported-event", "pass", 0, true],
  ["duplicate-event", "pass", 0, true],
  ["queue-interruption-recovery", "pass", 0, true],
  ["false-completion", "fail", 1, true],
  ["participant-not-invoked", "fail", 1, true],
  ["resolved-model-mismatch", "fail", 1, true],
  ["seeded-secret", "fail", 1, true],
  ["unknown-adapter-version", "fail", 1, true],
  ["repository-scope-leakage", "fail", 1, true],
  ["malformed-event", "invalid_input", 2, false],
  ["deletion-propagation-unavailable", "inconclusive", 0, true],
  ["deletion-propagation", "pass", 0, true],
] as const;

describe.each(expectedBuiltInResults)(
  "built-in evaluation suite %s",
  (suite, expectedStatus, expectedExitCode, expectationMatched) => {
    it(`returns ${expectedStatus} with exit code ${expectedExitCode}`, async () => {
      const outputRoot = await createTemporaryDirectory();
      const result = await runEvaluation({
        codeVersion: "test-code-version",
        outputRoot,
        suite,
      });

      expect(result.report.status).toBe(expectedStatus);
      expect(result.report.exitCode).toBe(expectedExitCode);
      expect(result.report.case.expectationMatched).toBe(expectationMatched);
      expect(result.report.case.fixtureVersion).toBe(1);

      const loaded = await loadEvaluationReport(result.runDirectory);
      expect(loaded.report).toEqual(result.report);

      const ledger = await readFile(
        join(result.runDirectory, "evidence-ledger.jsonl"),
        "utf8",
      );
      expect(ledger.trim().length).toBeGreaterThan(0);
      expect(
        ledger
          .trim()
          .split(/\r?\n/u)
          .every((line) => JSON.parse(line) !== null),
      ).toBe(true);
    });
  },
);

describe("evaluation runner failure classification", () => {
  it("returns exit code 2 for an invalid manifest", async () => {
    const root = await createTemporaryDirectory();
    const suite = join(root, "invalid-suite");
    const outputRoot = join(root, "runs");
    await mkdir(suite);
    await writeFile(
      join(suite, "suite.json"),
      JSON.stringify({
        manifest: {
          schemaVersion: 1,
          requirementId: "INVALID",
        },
        replaySpec: {},
        fixture: {},
      }),
      "utf8",
    );

    const result = await runEvaluation({
      codeVersion: "test-code-version",
      outputRoot,
      suite,
    });

    expect(result.report.status).toBe("invalid_input");
    expect(result.report.exitCode).toBe(2);
    expect(result.report.case.failureMessages).not.toHaveLength(0);
  });

  it("returns exit code 2 for an unknown verifier", async () => {
    const root = await createTemporaryDirectory();
    const suite = join(root, "unknown-verifier");
    const outputRoot = join(root, "runs");
    await mkdir(suite);
    await writeFile(
      join(suite, "suite.json"),
      JSON.stringify({
        manifest: {
          schemaVersion: 1,
          requirementId: "UNKNOWN-VERIFIER",
          milestone: "M0",
          statement: "Unknown verifiers are infrastructure errors.",
          scope: "workflow",
          replaySpecIds: [
            "unknown-verifier",
          ],
          verifierIds: [
            "does-not-exist",
          ],
          requiredEvidence: [],
          releaseGate: "hard",
        },
        replaySpec: {
          schemaVersion: 1,
          specId: "unknown-verifier",
          requirementId: "UNKNOWN-VERIFIER",
          inputRef: "inline://fixture",
          frozenEnvironment: "local-fixture-v1",
          expectedGate: "pass",
          expectedEvidence: [],
        },
        fixture: {
          schemaVersion: 1,
          fixtureVersion: 1,
          fixtureId: "unknown-verifier",
        },
      }),
      "utf8",
    );

    const result = await runEvaluation({
      codeVersion: "test-code-version",
      outputRoot,
      suite,
    });

    expect(result.report.status).toBe("invalid_input");
    expect(result.report.exitCode).toBe(2);
  });

  it("loads canonical fixture URIs containing JSONL events", async () => {
    const root = await createTemporaryDirectory();
    const suite = join(root, "jsonl-suite");
    const outputRoot = join(root, "runs");
    await mkdir(suite);
    await writeFile(
      join(suite, "requirement.json"),
      JSON.stringify({
        schemaVersion: 1,
        requirementId: "JSONL-001",
        milestone: "M0",
        statement: "Fixture JSONL events are replayable.",
        scope: "workflow",
        replaySpecIds: [
          "jsonl-suite",
        ],
        verifierIds: [
          "event-schema-source-version",
        ],
        requiredEvidence: [
          "event.supported",
        ],
        releaseGate: "hard",
      }),
      "utf8",
    );
    await writeFile(
      join(suite, "replay-spec.json"),
      JSON.stringify({
        schemaVersion: 1,
        specId: "jsonl-suite",
        requirementId: "JSONL-001",
        inputEvents: [
          "fixture://valid-supported-event/events.jsonl",
        ],
        frozenEnvironment: "local-fixture-v1",
        expectedGate: "pass",
        expectedEvidence: [
          "event.supported",
        ],
      }),
      "utf8",
    );

    const result = await runEvaluation({
      codeVersion: "test-code-version",
      outputRoot,
      suite,
    });

    expect(result.report.status).toBe("pass");
    expect(result.report.exitCode).toBe(0);
    expect(result.report.case.fixtureId).toBe("jsonl-suite");
  });

  it("returns exit code 2 when expected evidence is absent", async () => {
    const root = await createTemporaryDirectory();
    const suite = join(root, "missing-expected-evidence");
    const outputRoot = join(root, "runs");
    await mkdir(suite);
    await writeFile(
      join(suite, "suite.json"),
      JSON.stringify({
        manifest: {
          schemaVersion: 1,
          requirementId: "EXPECTED-EVIDENCE-001",
          milestone: "M0",
          statement: "Replay expectations name observable evidence.",
          scope: "workflow",
          replaySpecIds: [
            "missing-expected-evidence",
          ],
          verifierIds: [
            "event-schema-source-version",
          ],
          requiredEvidence: [
            "event.supported",
          ],
          releaseGate: "hard",
        },
        replaySpec: {
          schemaVersion: 1,
          specId: "missing-expected-evidence",
          requirementId: "EXPECTED-EVIDENCE-001",
          inputRef: "inline://fixture",
          frozenEnvironment: "local-fixture-v1",
          expectedGate: "pass",
          expectedEvidence: [
            "evidence.that.never.appears",
          ],
        },
        fixture: {
          schemaVersion: 1,
          fixtureVersion: 1,
          fixtureId: "missing-expected-evidence",
          events: [
            {
              schemaVersion: 1,
              eventId: "event-1",
              adapter: "copilot-cli",
              adapterVersion: "1.0.82-0",
              eventType: "prompt.submitted",
              timestamp: "2026-08-29T00:00:00.000Z",
              trust: "user",
            },
          ],
        },
      }),
      "utf8",
    );

    const result = await runEvaluation({
      codeVersion: "test-code-version",
      outputRoot,
      suite,
    });

    expect(result.report.status).toBe("invalid_input");
    expect(result.report.exitCode).toBe(2);
    expect(result.report.case.expectationMatched).toBe(false);
  });

  it("returns exit code 1 when the observed gate differs from the Replay expectation", async () => {
    const root = await createTemporaryDirectory();
    const suite = join(root, "expected-gate-mismatch");
    const outputRoot = join(root, "runs");
    await mkdir(suite);
    await writeFile(
      join(suite, "suite.json"),
      JSON.stringify({
        manifest: {
          schemaVersion: 1,
          requirementId: "EXPECTED-GATE-001",
          milestone: "M0",
          statement: "Replay gate expectations are executable.",
          scope: "workflow",
          replaySpecIds: [
            "expected-gate-mismatch",
          ],
          verifierIds: [
            "event-schema-source-version",
          ],
          requiredEvidence: [
            "event.supported",
          ],
          releaseGate: "hard",
        },
        replaySpec: {
          schemaVersion: 1,
          specId: "expected-gate-mismatch",
          requirementId: "EXPECTED-GATE-001",
          inputRef: "inline://fixture",
          frozenEnvironment: "local-fixture-v1",
          expectedGate: "fail",
          expectedEvidence: [
            "event.supported",
          ],
        },
        fixture: {
          schemaVersion: 1,
          fixtureVersion: 1,
          fixtureId: "expected-gate-mismatch",
          events: [
            {
              schemaVersion: 1,
              eventId: "event-1",
              adapter: "copilot-cli",
              adapterVersion: "1.0.82-0",
              eventType: "prompt.submitted",
              timestamp: "2026-08-29T00:00:00.000Z",
              trust: "user",
            },
          ],
        },
      }),
      "utf8",
    );

    const result = await runEvaluation({
      codeVersion: "test-code-version",
      outputRoot,
      suite,
    });

    expect(result.report.status).toBe("fail");
    expect(result.report.exitCode).toBe(1);
    expect(result.report.case.actualGate).toBe("pass");
    expect(result.report.case.expectationMatched).toBe(false);
  });

  it("fails a gate when Manifest required evidence is absent", async () => {
    const root = await createTemporaryDirectory();
    const suite = join(root, "missing-required-evidence");
    const outputRoot = join(root, "runs");
    await mkdir(suite);
    await writeFile(
      join(suite, "suite.json"),
      JSON.stringify({
        manifest: {
          schemaVersion: 1,
          requirementId: "REQUIRED-EVIDENCE-001",
          milestone: "M0",
          statement: "Hard requirements name evidence required to pass.",
          scope: "workflow",
          replaySpecIds: [
            "missing-required-evidence",
          ],
          verifierIds: [
            "event-schema-source-version",
          ],
          requiredEvidence: [
            "required.but.missing",
          ],
          releaseGate: "hard",
        },
        replaySpec: {
          schemaVersion: 1,
          specId: "missing-required-evidence",
          requirementId: "REQUIRED-EVIDENCE-001",
          inputRef: "inline://fixture",
          frozenEnvironment: "local-fixture-v1",
          expectedGate: "fail",
          expectedEvidence: [
            "event.supported",
          ],
        },
        fixture: {
          schemaVersion: 1,
          fixtureVersion: 1,
          fixtureId: "missing-required-evidence",
          events: [
            {
              schemaVersion: 1,
              eventId: "event-1",
              adapter: "copilot-cli",
              adapterVersion: "1.0.82-0",
              eventType: "prompt.submitted",
              timestamp: "2026-08-29T00:00:00.000Z",
              trust: "user",
            },
          ],
        },
      }),
      "utf8",
    );

    const result = await runEvaluation({
      codeVersion: "test-code-version",
      outputRoot,
      suite,
    });

    expect(result.report.status).toBe("fail");
    expect(result.report.exitCode).toBe(1);
    expect(result.report.case.expectationMatched).toBe(true);
    expect(result.report.case.failureMessages).toContain(
      "Missing required evidence status: required.but.missing.",
    );
  });

  it("returns exit code 2 for a missing suite or input file", async () => {
    const root = await createTemporaryDirectory();
    const missingSuite = await runEvaluation({
      codeVersion: "test-code-version",
      outputRoot: join(root, "runs-one"),
      suite: "suite-that-does-not-exist",
    });

    expect(missingSuite.report.status).toBe("invalid_input");
    expect(missingSuite.report.exitCode).toBe(2);

    const suite = join(root, "missing-input");
    await mkdir(suite);
    await writeFile(
      join(suite, "requirement.json"),
      JSON.stringify({
        schemaVersion: 1,
        requirementId: "MISSING-INPUT-001",
        milestone: "M0",
        statement: "Missing replay inputs are invalid.",
        scope: "workflow",
        replaySpecIds: [
          "missing-input",
        ],
        verifierIds: [
          "event-schema-source-version",
        ],
        requiredEvidence: [],
        releaseGate: "hard",
      }),
      "utf8",
    );
    await writeFile(
      join(suite, "replay-spec.json"),
      JSON.stringify({
        schemaVersion: 1,
        specId: "missing-input",
        requirementId: "MISSING-INPUT-001",
        inputRef: "does-not-exist.json",
        frozenEnvironment: "local-fixture-v1",
        expectedGate: "pass",
        expectedEvidence: [],
      }),
      "utf8",
    );

    const missingInput = await runEvaluation({
      codeVersion: "test-code-version",
      outputRoot: join(root, "runs-two"),
      suite,
    });

    expect(missingInput.report.status).toBe("invalid_input");
    expect(missingInput.report.exitCode).toBe(2);
  });

  it("redacts secret-bearing Ledger entries before persistence", async () => {
    const root = await createTemporaryDirectory();
    const suite = join(root, "ledger-preflight-secret");
    const outputRoot = join(root, "runs");
    const secret = "9wM3QfT7xL2nV8pR4sK6dH1cB5yJ0uZa";
    await mkdir(suite);
    await writeFile(
      join(suite, "suite.json"),
      JSON.stringify({
        manifest: {
          schemaVersion: 1,
          requirementId: "LEDGER-SECRET-001",
          milestone: "M0",
          statement: "Secrets are removed before Ledger persistence.",
          scope: "workflow",
          replaySpecIds: [
            "ledger-preflight-secret",
          ],
          verifierIds: [
            "secret-persistence",
          ],
          requiredEvidence: [
            "secret.redacted_before_ledger",
            "secret.scan.completed",
          ],
          releaseGate: "hard",
        },
        replaySpec: {
          schemaVersion: 1,
          specId: "ledger-preflight-secret",
          requirementId: "LEDGER-SECRET-001",
          inputRef: "inline://fixture",
          frozenEnvironment: "local-fixture-v1",
          expectedGate: "fail",
          expectedEvidence: [
            "secret.redacted_before_ledger",
            "secret.detected",
          ],
        },
        fixture: {
          schemaVersion: 1,
          fixtureVersion: 1,
          fixtureId: "ledger-preflight-secret",
          evidence: [
            {
              schemaVersion: 1,
              ledgerEntryId: "unsafe-ledger-entry",
              runId: "fixture",
              requestedModel: secret,
              status: "model.requested",
              timestamp: "2026-08-29T00:00:00.000Z",
            },
          ],
        },
      }),
      "utf8",
    );

    const result = await runEvaluation({
      codeVersion: "test-code-version",
      outputRoot,
      suite,
    });
    const ledger = await readFile(
      join(result.runDirectory, "evidence-ledger.jsonl"),
      "utf8",
    );

    expect(result.report.status).toBe("fail");
    expect(result.report.exitCode).toBe(1);
    expect(ledger).not.toContain(secret);
    expect(ledger).toContain("secret.redacted_before_ledger");
  });

  it("redacts secret-bearing verifier messages before report persistence", async () => {
    const root = await createTemporaryDirectory();
    const suite = join(root, "report-secret");
    const outputRoot = join(root, "runs");
    const secret = "ghp_1234567890abcdefghijklmnopqrst";
    await mkdir(suite);
    await writeFile(
      join(suite, "suite.json"),
      JSON.stringify({
        manifest: {
          schemaVersion: 1,
          requirementId: "REPORT-SECRET-001",
          milestone: "M0",
          statement: "Reports redact untrusted values.",
          scope: "workflow",
          replaySpecIds: [
            "report-secret",
          ],
          verifierIds: [
            "event-schema-source-version",
          ],
          requiredEvidence: [
            "event.unsupported_type",
          ],
          releaseGate: "hard",
        },
        replaySpec: {
          schemaVersion: 1,
          specId: "report-secret",
          requirementId: "REPORT-SECRET-001",
          inputRef: "inline://fixture",
          frozenEnvironment: "local-fixture-v1",
          expectedGate: "fail",
          expectedEvidence: [
            "event.unsupported_type",
          ],
        },
        fixture: {
          schemaVersion: 1,
          fixtureVersion: 1,
          fixtureId: "report-secret",
          events: [
            {
              schemaVersion: 1,
              eventId: "event-1",
              adapter: "copilot-cli",
              adapterVersion: "1.0.82-0",
              eventType: secret,
              timestamp: "2026-08-29T00:00:00.000Z",
              trust: "system",
            },
          ],
        },
      }),
      "utf8",
    );

    const result = await runEvaluation({
      codeVersion: "test-code-version",
      outputRoot,
      suite,
    });
    const reportJson = await readFile(
      join(result.runDirectory, "report.json"),
      "utf8",
    );
    const reportMarkdown = await readFile(
      join(result.runDirectory, "report.md"),
      "utf8",
    );

    expect(result.report.case.failureMessages.join(" ")).not.toContain(
      secret,
    );
    expect(reportJson).not.toContain(secret);
    expect(reportMarkdown).not.toContain(secret);
    expect(reportMarkdown).toContain("[REDACTED]");
  });
});

describe("evaluation artifacts", () => {
  it("rebuilds report.md from stable report.json", async () => {
    const outputRoot = await createTemporaryDirectory();
    const result = await runEvaluation({
      codeVersion: "test-code-version",
      outputRoot,
      runId: "stable-report-run",
      suite: "false-completion",
    });
    await writeFile(join(result.runDirectory, "report.md"), "stale", "utf8");

    const regenerated = await regenerateMarkdownReport(
      result.runDirectory,
    );

    expect(regenerated.markdown).toContain("PROCESS-CLAIM-001");
    expect(regenerated.markdown).toContain("claim-evidence-1");
    expect(regenerated.markdown).toContain("lacks successful invocation");
  });

  it("resumes an existing Evidence Ledger without duplicating entries", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "evidence-ledger.jsonl");
    const first = new EvidenceLedgerWriter(path);
    const second = new EvidenceLedgerWriter(path);
    const entry = {
      schemaVersion: 1 as const,
      ledgerEntryId: "existing-entry",
      runId: "run-1",
      status: "observed",
      timestamp: "2026-08-30T00:00:00.000Z",
    };

    await first.initialize();
    await first.append([
      entry,
    ]);
    await second.initialize();
    await expect(
      second.appendIfAbsent([
        entry,
      ]),
    ).resolves.toEqual([]);
    await expect(
      second.append([
        entry,
      ]),
    ).rejects.toBeInstanceOf(DuplicateLedgerEntryError);
  });

  it("recovers an incomplete trailing Ledger record", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "evidence-ledger.jsonl");
    const entry = {
      schemaVersion: 1 as const,
      ledgerEntryId: "complete-entry",
      runId: "run-1",
      status: "observed",
      timestamp: "2026-08-30T00:00:00.000Z",
    };
    await writeFile(
      path,
      `${JSON.stringify(entry)}\n{"schemaVersion":1`,
      "utf8",
    );
    const writer = new EvidenceLedgerWriter(path);
    await writer.initialize();
    await writer.append([
      {
        ...entry,
        ledgerEntryId: "after-recovery",
      },
    ]);

    const lines = (await readFile(path, "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as unknown);
    expect(lines).toHaveLength(2);
  });

  it("rejects a malformed complete Ledger record", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "evidence-ledger.jsonl");
    await writeFile(
      path,
      "{\"schemaVersion\":1}\n",
      "utf8",
    );

    await expect(
      new EvidenceLedgerWriter(path).initialize(),
    ).rejects.toThrow();
  });

  it("sanitizes every Ledger append source", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "evidence-ledger.jsonl");
    const writer = new EvidenceLedgerWriter(path);
    const secret = "9wM3QfT7xL2nV8pR4sK6dH1cB5yJ0uZa";
    await writer.initialize();

    const persisted = await writer.append([
      {
        schemaVersion: 1,
        ledgerEntryId: "generated-entry",
        runId: "run-1",
        participantId: secret,
        status: "participant.observed",
        timestamp: "2026-08-29T00:00:00.000Z",
      },
    ]);
    const content = await readFile(path, "utf8");

    expect(persisted).toEqual([
      expect.objectContaining({
        ledgerEntryId: "generated-entry",
        status: "secret.redacted_before_ledger",
      }),
    ]);
    expect(content).not.toContain(secret);
  });

  it("rejects known secrets in immutable Ledger identifiers", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "evidence-ledger.jsonl");
    const writer = new EvidenceLedgerWriter(path);
    await writer.initialize();

    const unsafeIds = [
      "entry_ghp_1234567890abcdefghijklmnopqrst",
      "github_pat_1234567890abcdefghijklmnopqrst",
      "sk-proj-1234567890abcdefghijklmnopqrst",
      "ASIA1234567890ABCDEF",
    ];
    for (const ledgerEntryId of unsafeIds) {
      await expect(
        writer.append([
          {
            schemaVersion: 1,
            ledgerEntryId,
            runId: "run-1",
            status: "event.observed",
            timestamp: "2026-08-29T00:00:00.000Z",
          },
        ]),
      ).rejects.toThrow("unsafe immutable identifier");
    }
    expect(await readFile(path, "utf8")).toBe("");
  });

  it("sanitizes hexadecimal high-entropy Ledger fields", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "evidence-ledger.jsonl");
    const writer = new EvidenceLedgerWriter(path);
    const secret = "0123456789abcdefabcdef0123456789abcdefabcd";
    await writer.initialize();

    const persisted = await writer.append([
      {
        schemaVersion: 1,
        ledgerEntryId: "hex-secret-entry",
        runId: "run-1",
        requestedModel: secret,
        status: "model.requested",
        timestamp: "2026-08-29T00:00:00.000Z",
      },
    ]);

    expect(persisted[0]?.status).toBe("secret.redacted_before_ledger");
    expect(await readFile(path, "utf8")).not.toContain(secret);
  });

  it("does not redact structured model identifiers", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "evidence-ledger.jsonl");
    const writer = new EvidenceLedgerWriter(path);
    const models = [
      "mai-code-1-flash-picker",
      "claude-3-5-sonnet-20241022",
      "deepseek-r1-distill-llama-70b",
    ];
    await writer.initialize();

    const persisted = await writer.append(
      models.map((model, index) => ({
        schemaVersion: 1 as const,
        ledgerEntryId: `model-${index}`,
        runId: "run-1",
        resolvedModel: model,
        status: "model.resolved",
        timestamp: "2026-08-29T00:00:00.000Z",
      })),
    );

    expect(persisted.map((entry) => entry.resolvedModel)).toEqual(models);
  });

  it("rejects duplicate Ledger IDs before verification", async () => {
    const root = await createTemporaryDirectory();
    const suite = join(root, "duplicate-ledger-id");
    const outputRoot = join(root, "runs");
    await mkdir(suite);
    await writeFile(
      join(suite, "suite.json"),
      JSON.stringify({
        manifest: {
          schemaVersion: 1,
          requirementId: "LEDGER-ID-001",
          milestone: "M0",
          statement: "Ledger identities are unambiguous.",
          scope: "workflow",
          replaySpecIds: [
            "duplicate-ledger-id",
          ],
          verifierIds: [
            "process-claim-execution-consistency",
          ],
          requiredEvidence: [],
          releaseGate: "hard",
        },
        replaySpec: {
          schemaVersion: 1,
          specId: "duplicate-ledger-id",
          requirementId: "LEDGER-ID-001",
          inputRef: "inline://fixture",
          frozenEnvironment: "local-fixture-v1",
          expectedGate: "fail",
          expectedEvidence: [],
        },
        fixture: {
          schemaVersion: 1,
          fixtureVersion: 1,
          fixtureId: "duplicate-ledger-id",
          evidence: [
            {
              schemaVersion: 1,
              ledgerEntryId: "duplicate-id",
              runId: "fixture",
              claimId: "claim-1",
              status: "claim.declared",
              timestamp: "2026-08-29T00:00:00.000Z",
            },
            {
              schemaVersion: 1,
              ledgerEntryId: "duplicate-id",
              runId: "fixture",
              claimId: "claim-other",
              status: "claim.declared",
              timestamp: "2026-08-29T00:00:00.000Z",
            },
          ],
        },
      }),
      "utf8",
    );

    const result = await runEvaluation({
      codeVersion: "test-code-version",
      outputRoot,
      suite,
    });

    expect(result.report.status).toBe("invalid_input");
    expect(result.report.exitCode).toBe(2);
  });

  it("serializes concurrent Ledger appends before uniqueness checks", async () => {
    const root = await createTemporaryDirectory();
    const path = join(root, "evidence-ledger.jsonl");
    const writer = new EvidenceLedgerWriter(path);
    await writer.initialize();
    const entry = {
      schemaVersion: 1 as const,
      ledgerEntryId: "concurrent-id",
      runId: "run-1",
      status: "event.observed",
      timestamp: "2026-08-29T00:00:00.000Z",
    };

    const results = await Promise.allSettled([
      writer.append([
        entry,
      ]),
      writer.append([
        entry,
      ]),
    ]);
    const lines = (await readFile(path, "utf8"))
      .trim()
      .split(/\r?\n/u);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });
});

describe("provenloop evaluation CLI", () => {
  it("runs a negative suite and regenerates its report", async () => {
    const outputRoot = await createTemporaryDirectory();
    const cli = resolve("packages", "cli", "dist", "bin.js");
    const run = spawnSync(
      process.execPath,
      [
        cli,
        "eval",
        "run",
        "--suite",
        "false-completion",
        "--out",
        outputRoot,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );

    expect(run.status).toBe(1);
    const runDirectory = run.stdout.trim().split(": ").at(-1);
    if (!runDirectory) {
      throw new Error("CLI did not print the evaluation run directory.");
    }

    const report = spawnSync(
      process.execPath,
      [
        cli,
        "eval",
        "report",
        "--run",
        runDirectory,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );

    expect(report.status).toBe(1);
    expect(report.stdout).toContain("ProvenLoop evaluation report");
    expect(report.stdout).toContain("PROCESS-CLAIM-001");
  });

  it("returns infrastructure exit code 3 when output setup fails", async () => {
    const root = await createTemporaryDirectory();
    const outputFile = join(root, "not-a-directory");
    await writeFile(outputFile, "occupied", "utf8");
    const cli = resolve("packages", "cli", "dist", "bin.js");

    const run = spawnSync(
      process.execPath,
      [
        cli,
        "eval",
        "run",
        "--suite",
        "valid-supported-event",
        "--out",
        outputFile,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );

    expect(run.status).toBe(3);
    expect(run.stderr).not.toBe("");
  });

  it("returns invalid-input exit code 2 for a missing report", async () => {
    const cli = resolve("packages", "cli", "dist", "bin.js");
    const report = spawnSync(
      process.execPath,
      [
        cli,
        "eval",
        "report",
        "--run",
        "run-that-does-not-exist",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );

    expect(report.status).toBe(2);
    expect(report.stderr).toContain("missing or invalid");
  });
});
