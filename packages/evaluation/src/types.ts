import type {
  EvidenceLedgerEntry,
  GateResult,
  ReplaySpec,
  RequirementManifest,
} from "@provenloop/contracts";

import type { EvaluationFixture } from "./fixture.js";

export interface LoadedEvaluationSuite {
  readonly fixture: EvaluationFixture;
  readonly manifest: RequirementManifest;
  readonly replaySpec: ReplaySpec;
  readonly rootDirectory: string;
  readonly suiteId: string;
}

export interface VerifierContext {
  readonly fixture: EvaluationFixture;
  readonly generatedAt: string;
  readonly ledgerEntries: readonly EvidenceLedgerEntry[];
  readonly manifest: RequirementManifest;
  readonly replaySpec: ReplaySpec;
  readonly runId: string;
}

export interface VerifierOutcome {
  readonly gate: GateResult;
  readonly invalidInput?: boolean;
  readonly ledgerEntries?: readonly EvidenceLedgerEntry[];
}

export interface EvaluationCaseReport {
  readonly actualGate: "pass" | "fail" | "inconclusive";
  readonly evidenceIds: readonly string[];
  readonly expectationMatched: boolean;
  readonly expectedGate: "pass" | "fail" | "inconclusive";
  readonly failureMessages: readonly string[];
  readonly fixtureId: string;
  readonly fixtureVersion: number;
  readonly gates: readonly GateResult[];
  readonly requirementId: string;
  readonly specId: string;
}

export interface EvaluationReport {
  readonly schemaVersion: 1;
  readonly case: EvaluationCaseReport;
  readonly codeVersion: string;
  readonly completedAt: string;
  readonly exitCode: 0 | 1 | 2 | 3;
  readonly ledgerPath: string;
  readonly limitations: readonly string[];
  readonly reportVersion: 1;
  readonly runId: string;
  readonly startedAt: string;
  readonly status:
    | "pass"
    | "fail"
    | "inconclusive"
    | "invalid_input"
    | "infrastructure_error";
  readonly suiteId: string;
}

export interface RunEvaluationOptions {
  readonly codeVersion?: string;
  readonly now?: () => Date;
  readonly outputRoot: string;
  readonly runId?: string;
  readonly suite: string;
}

export interface RunEvaluationResult {
  readonly report: EvaluationReport;
  readonly runDirectory: string;
}
