import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AdapterOperationResult,
  AgentAdapter,
  KnowledgeCandidate,
  Scope,
  SourceReference,
} from "@provenloop/contracts";
import {
  experiencePurposeSchema,
  provenLoopCapabilitySchema,
  scopeSchema,
} from "@provenloop/contracts";
import {
  CopilotCliAdapter,
  cancelLearningScratch,
  AUTOMATIC_LEARNING_DISCLOSURE,
  resolveAutomaticLearning,
  approveCopilotLearningHooks,
  getCopilotAutomaticLearningHostCapability,
  readCopilotAdapterState,
  writeCopilotAdapterState,
  readTrustedSessionContext,
  type TrustedSessionContext,
} from "@provenloop/copilot-adapter";
import {
  evaluateEpisodeAssociationDataset,
  EvidenceLedgerWriter,
  EvaluationReportInputError,
  loadEpisodeAssociationDataset,
  M0AcceptanceEvidenceInputError,
  regenerateMarkdownReport,
  renderEpisodeAssociationReport,
  runEvaluation,
  runM0ReleaseGate,
  runM1ReleaseGate,
  runM2ReleaseGate,
  runMvpReleaseGate,
  MvpReleaseInputError,
} from "@provenloop/evaluation";
import {
  DeletionPropagationGateError,
  DeletionService,
  KnowledgeControlService,
  planCaptureRetention,
  applyCaptureRetention,
  type CaptureWorkerRunResult,
  type RememberKnowledgeInput,
} from "@provenloop/host";
import {
  resolveWindowsProvenLoopDataRoot,
  resolveWindowsProvenLoopLeaseName,
  resolveWindowsProvenLoopPaths,
  WindowsCaptureQueue,
  WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";
import {
  branchScopeIdFor,
  KnowledgeProjectionManager,
  SqliteFtsKnowledgeBackend,
} from "@provenloop/retrieval";
import {
  CanonicalSqliteStore,
} from "@provenloop/storage-sqlite";

import {
  completeM0DailyAcceptance,
  startM0DailyAcceptance,
} from "./m0-daily-acceptance.js";
import {
  runMcpServer,
  type McpServerOptions,
} from "./run-mcp-server.js";
import {
  runCaptureWorkerOnce,
  type RunCaptureWorkerOnceOptions,
} from "./run-worker.js";
import {
  PROVENLOOP_CODE_VERSION,
  releaseMetadata,
} from "./release-metadata.js";
import {
  exportLocalObservationManifest,
  readLocalObservationSummary,
} from "./observation-summary.js";
import { invalidateLocalObservationProjection } from "./collect-observations.js";
import { runUi } from "./run-ui.js";
import { readLearningReadiness } from "./run-learning.js";
import { previewRecordsReset, resetAllRecords } from "./reset-records.js";

export interface CliIo {
  readonly error: (message: string) => void;
  readonly log: (message: string) => void;
}

export interface CliDependencies {
  readonly createAdapter: (
    dataRoot: string,
  ) => AgentAdapter;
  readonly runMcpServer: (
    options?: McpServerOptions,
  ) => Promise<void>;
  readonly runWorker?: (
    options: RunCaptureWorkerOnceOptions,
  ) => Promise<CaptureWorkerRunResult>;
}

const defaultIo: CliIo = {
  error: (message) => console.error(message),
  log: (message) => console.log(message),
};

const resolveCliTrustedContext = async (
  root: string,
): Promise<TrustedSessionContext | undefined> => {
  const sessionId = process.env.SESSION_ID?.trim();
  return sessionId ? readTrustedSessionContext(root, sessionId) : undefined;
};

const defaultDependencies: CliDependencies = {
  createAdapter: (dataRoot) =>
    new CopilotCliAdapter({
      cliBinPath: fileURLToPath(
        new URL("./bin.js", import.meta.url),
      ),
      dataRoot,
      extensionModuleUrl:
        new URL("./extension-entry.js", import.meta.url).href,
    }),
  runMcpServer: (options) =>
    runMcpServer(undefined, options),
  runWorker: runCaptureWorkerOnce,
};

const option = (
  args: readonly string[],
  name: string,
): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const discoveryOptions = (
  args: readonly string[],
): Pick<RememberKnowledgeInput, "purposes" | "topics" | "sourceReferences"> | undefined => {
  const purpose = option(args, "--purpose");
  const purposeResult = purpose === undefined ? undefined : experiencePurposeSchema.safeParse(purpose);
  const topics = option(args, "--topics")?.split(",").map((topic) => topic.trim());
  const source = option(args, "--source")?.trim();
  const sourceKind = option(args, "--source-kind") ?? (source && /^https?:\/\//iu.test(source) ? "url" : "file");
  if (purposeResult?.success === false ||
      (topics !== undefined && (topics.length > 8 || topics.some((topic) => !topic || topic.length > 128))) ||
      (source !== undefined && (!source || source.length > 2_048)) ||
      (source === undefined && option(args, "--source-kind") !== undefined) ||
      !["file", "directory", "url"].includes(sourceKind)) return undefined;
  return {
    ...(purposeResult?.success ? { purposes: [purposeResult.data] } : {}),
    ...(topics === undefined ? {} : { topics }),
    ...(source === undefined ? {} : { sourceReferences: [{
      kind: sourceKind as SourceReference["kind"],
      locator: sourceKind === "url" ? source : resolve(option(args, "--cwd") ?? process.cwd(), source),
    }] }),
  };
};

const usage = `Usage:
  provenloop records clear [--confirm] [--data-root <directory>]
  provenloop ui [--port <0-65535>] [--no-open] [--data-root <directory>]
  provenloop install [--no-auto-collect] [--data-root <directory>]
  provenloop version
  provenloop runtime extension-path
  provenloop upgrade [--data-root <directory>]
  provenloop status [--data-root <directory>]
  provenloop doctor [--online] [--data-root <directory>]
  provenloop enable <capability> [--data-root <directory>]
  provenloop disable <capability> [--data-root <directory>]
  provenloop collection <enable|disable> [--data-root <directory>]
  provenloop learning <status|enable|disable|mute|unmute> [--confirm] [--data-root <directory>]
  provenloop learning status [--cwd <repository-directory>] [--data-root <directory>]
  provenloop learning approve-hooks --cwd <repository-directory> --confirm
  provenloop remember --content <text> --when <condition> [--not-when <condition>] [--purpose <fact|constraint|lesson|procedure|rationale>] [--topics <concept-ids>] [--source <locator>] [--source-kind <file|directory|url>] [--scope <personal|workflow|repository|branch>] [--workflow <id>] [--cwd <directory>] [--data-root <directory>]
    Source references are saved as pointers. Local paths resolve from --cwd; no source is opened or fetched.
  provenloop knowledge list [--state <state>] [--scope <scope>] [--workflow <id>] [--cwd <directory>] [--data-root <directory>]
  provenloop knowledge show <knowledge-id> [--scope <scope>] [--workflow <id>] [--cwd <directory>] [--data-root <directory>]
  provenloop knowledge confirm <knowledge-id> --expect <review-digest> --confirm [--resolve <evidence-ids>] [--reason <text>] [--scope <scope>] [--workflow <id>] [--cwd <directory>] [--data-root <directory>]
  provenloop knowledge replace <knowledge-id> --content <text> --expect <review-digest> --confirm [--resolve <evidence-ids>] [--when <condition>] [--not-when <condition>] [--purpose <purpose>] [--topics <concept-ids>] [--source <locator>] [--source-kind <file|directory|url>] [--reason <text>] [--scope <scope>] [--workflow <id>] [--cwd <directory>] [--data-root <directory>]
    Metadata-only replacements preserve unspecified user metadata. Content, conditions, or scope changes discard previous discovery metadata.
  provenloop knowledge revoke <knowledge-id> --expect <review-digest> --confirm [--reason <text>] [--scope <scope>] [--workflow <id>] [--cwd <directory>] [--data-root <directory>]
    Workflow scope requires the matching live SDK workflow and workspace; --workflow alone is not authority.
  provenloop correct <knowledge-id> [--reason <text>] [--data-root <directory>]
  provenloop mute <knowledge-id> --session <id> [--data-root <directory>]
  provenloop forget <knowledge-or-playbook> [--data-root <directory>]
  provenloop delete (--source <event-or-dedup-id> | --session <id> | --episode <id> | --knowledge <id>) [--data-root <directory>]
  provenloop worker run [--batch-size <count>] [--data-root <directory>]
  provenloop capture retention plan [--older-than <ISO-time>] [--data-root <directory>]
  provenloop capture retention apply --older-than <ISO-time> --expect <digest> --sessions <id,id> --confirm [--data-root <directory>]
  provenloop uninstall [--purge] [--data-root <directory>]
  provenloop purge [--data-root <directory>]
  provenloop acceptance start [--session-root <directory>] [--data-root <directory>]
  provenloop acceptance complete [--drain-timeout <seconds>] [--data-root <directory>]
  provenloop observations show [--date YYYY-MM-DD] [--session <id>] [--data-root <directory>]
  provenloop observations export [--date YYYY-MM-DD] [--session <id>] [--data-root <directory>]
    Observations are observational, not controlled benefit evidence or release approval.
  provenloop eval episodes [--dataset <file>]
  provenloop eval m0 --out <directory> [--evidence <file>]
  provenloop eval m1 --out <directory> [--dataset <file>] [--stable]
  provenloop eval m2 --out <directory> [--dataset <file>] [--automatic-learning-evidence <file>] [--stable]
  provenloop eval mvp --out <directory> [--evidence <file>] [--automatic-learning-evidence <file>] [--stable]
  provenloop eval run --suite <suite> --out <directory>
  provenloop eval report --run <run-id-or-directory>`;

const dataRoot = (args: readonly string[]): string =>
  option(args, "--data-root") ??
  resolveWindowsProvenLoopDataRoot();

const hasInvalidOptionValue = (
  args: readonly string[],
  name: string,
): boolean => {
  const index = args.indexOf(name);
  return index !== -1 && (
    args[index + 1] === undefined ||
    args[index + 1]?.startsWith("--") === true
  );
};

const hasOnlyOptions = (
  args: readonly string[],
  startIndex: number,
  input: {
    readonly flags?: readonly string[];
    readonly values?: readonly string[];
  },
): boolean => {
  const flags = new Set(input.flags ?? []);
  const values = new Set(input.values ?? []);
  const seen = new Set<string>();
  let index = startIndex;
  while (index < args.length) {
    const argument = args[index];
    if (
      argument === undefined ||
      seen.has(argument)
    ) {
      return false;
    }
    if (flags.has(argument)) {
      seen.add(argument);
      index += 1;
      continue;
    }
    if (!values.has(argument)) {
      return false;
    }
    const value = args[index + 1];
    if (
      value === undefined ||
      value.startsWith("--")
    ) {
      return false;
    }
    seen.add(argument);
    index += 2;
  }
  return true;
};

const operationExitCode = (
  result: AdapterOperationResult,
): number => result.status === "incompatible" ? 1 : 0;

const MAINTENANCE_LEASE_TIMEOUT_MS = 5_000;
const LEASE_RETRY_DELAY_MS = 25;

const acquireMaintenanceLease = async (
  root: string,
  purpose: "knowledge-projection" | "observations" | "adapter-state" | "capture-worker",
) => {
  const leaseName = await resolveWindowsProvenLoopLeaseName(
    root,
    purpose,
  );
  const provider = new WindowsNamedPipeLeaseProvider(leaseName);
  const deadline =
    Date.now() + MAINTENANCE_LEASE_TIMEOUT_MS;
  let lease = await provider.tryAcquire();
  while (lease === undefined) {
    if (Date.now() >= deadline) {
      throw new Error(
        purpose === "knowledge-projection"
          ? "Timed out waiting for the Knowledge projection lease. Retry the command after maintenance completes."
          : `Timed out waiting for the ${purpose} lease. Retry after the active operation completes.`,
      );
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, LEASE_RETRY_DELAY_MS);
    });
    lease = await provider.tryAcquire();
  }
  return lease;
};

const acquireKnowledgeProjectionLease = (root: string) =>
  acquireMaintenanceLease(root, "knowledge-projection");

const withKnowledgeControl = async <T>(
  root: string,
  operation: (
    service: KnowledgeControlService,
  ) => Promise<T> | T,
  workflowScopeId?: string,
): Promise<T> => {
  const paths = resolveWindowsProvenLoopPaths(root);
  await access(paths.rootMarker);
  await access(paths.database);
  const outerLease = await acquireKnowledgeProjectionLease(
    paths.root,
  );
  let store: CanonicalSqliteStore | undefined;
  let backend: SqliteFtsKnowledgeBackend | undefined;
  try {
    store = new CanonicalSqliteStore(paths.database);
    backend = new SqliteFtsKnowledgeBackend(
      paths.knowledgeDatabase,
    );
    const projection = new KnowledgeProjectionManager({
      backend,
      store,
    });
    return await operation(
      new KnowledgeControlService({
        projection: {
          acquireLease: async () => ({
            release: async () => undefined,
          }),
          rebuild: () => projection.rebuild().then(() => undefined),
        },
        store,
        ...(workflowScopeId === undefined ? {} : { workflowScopeId }),
      }),
    );
  } finally {
    await backend?.closeAsync();
    store?.close();
    await outerLease.release();
  }
};

const rememberScopeId = async (
  scope: Scope,
  args: readonly string[],
  adapter: AgentAdapter,
  root: string,
): Promise<string | undefined> => {
  if (scope === "personal") {
    return undefined;
  }
  if (scope === "workflow") {
    const workflow = option(args, "--workflow")?.trim();
    if (!workflow) {
      throw new Error(
        "Workflow-scoped Knowledge requires --workflow.",
      );
    }
    const trusted = await resolveCliTrustedContext(root);
    if (
      trusted?.workflowScopeId !== workflow ||
      (trusted.repositoryState !== "known_repo" &&
        trusted.repositoryState !== "known_outside_repo") ||
      resolve(trusted.cwd).toLowerCase() !==
        resolve(option(args, "--cwd") ?? process.cwd()).toLowerCase()
    ) {
      throw new Error(
        "Workflow-scoped Knowledge requires a matching trusted workflow in the active workspace.",
      );
    }
    return workflow;
  }
  const identity = await adapter.resolveSession({
    adapterVersion: "user-control",
    cwd: option(args, "--cwd") ?? process.cwd(),
    sessionId: `control-${randomUUID()}`,
  });
  if (identity.repositoryId === undefined) {
    throw new Error(
      "Repository identity is unavailable for remember.",
    );
  }
  if (scope === "repository") {
    return identity.repositoryId;
  }
  if (identity.branch === undefined) {
    throw new Error(
      "Branch identity is unavailable for remember.",
    );
  }
  return branchScopeIdFor(
    identity.repositoryId,
    identity.branch,
  );
};

const runKnowledgeControlCommand = async (
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> => {
  const shapeIsValid =
    args[0] === "remember"
      ? hasOnlyOptions(args, 1, {
          values: [
            "--content",
            "--cwd",
            "--data-root",
            "--not-when",
            "--scope",
            "--when",
            "--workflow",
            "--purpose",
            "--topics",
            "--source",
            "--source-kind",
          ],
        })
      : args[0] === "correct"
        ? hasOnlyOptions(args, 2, {
            values: [
              "--data-root",
              "--reason",
            ],
          })
        : args[0] === "mute"
          ? hasOnlyOptions(args, 2, {
              values: [
                "--data-root",
                "--session",
              ],
            })
          : args[0] === "forget"
            ? hasOnlyOptions(args, 2, {
                values: [
                  "--data-root",
                ],
              })
            : false;
  if (
    !shapeIsValid ||
    hasInvalidOptionValue(args, "--data-root") ||
    hasInvalidOptionValue(args, "--content") ||
    hasInvalidOptionValue(args, "--when") ||
    hasInvalidOptionValue(args, "--not-when") ||
    hasInvalidOptionValue(args, "--scope") ||
    hasInvalidOptionValue(args, "--workflow") ||
    hasInvalidOptionValue(args, "--cwd") ||
    hasInvalidOptionValue(args, "--reason") ||
    hasInvalidOptionValue(args, "--session") ||
    hasInvalidOptionValue(args, "--purpose") ||
    hasInvalidOptionValue(args, "--topics") ||
    hasInvalidOptionValue(args, "--source") ||
    hasInvalidOptionValue(args, "--source-kind")
  ) {
    io.error(usage);
    return 2;
  }
  const root = dataRoot(args);
  try {
    switch (args[0]) {
      case "remember": {
        const content = option(args, "--content");
        const appliesWhen = option(args, "--when");
        const discovery = discoveryOptions(args);
        const scopeResult = scopeSchema.safeParse(
          option(args, "--scope") ?? "repository",
        );
        if (
          !content ||
          !appliesWhen ||
          !scopeResult.success || discovery === undefined
        ) {
          io.error(usage);
          return 2;
        }
        const adapter = dependencies.createAdapter(root);
        const scopeId = await rememberScopeId(
          scopeResult.data,
          args,
          adapter,
          root,
        );
        const result = await withKnowledgeControl(
          root,
          (service) =>
            service.remember({
              appliesWhen: [
                appliesWhen,
              ],
              content,
              nonApplicability: [
                ...(option(args, "--not-when") === undefined
                  ? []
                  : [
                      option(args, "--not-when") ?? "",
                    ]),
              ],
              scope: scopeResult.data,
              ...(scopeId === undefined ? {} : { scopeId }),
              ...discovery,
            }),
          scopeResult.data === "workflow" ? scopeId : undefined,
        );
        io.log(
          result.changed
            ? `Remembered Knowledge ${result.candidate?.knowledgeId}.`
            : `Knowledge ${result.candidate?.knowledgeId} was already remembered.`,
        );
        return 0;
      }
      case "correct": {
        const knowledgeId = args[1]?.trim();
        const reason = option(args, "--reason");
        if (!knowledgeId || knowledgeId.startsWith("--")) {
          io.error(usage);
          return 2;
        }
        const result = await withKnowledgeControl(
          root,
          (service) =>
            service.correct({
              knowledgeId,
              ...(reason === undefined
                ? {}
                : {
                    reason,
                  }),
            }),
        );
        io.log(
          result.changed
            ? `Knowledge ${knowledgeId} marked disputed.`
            : `Knowledge ${knowledgeId} was already corrected.`,
        );
        return 0;
      }
      case "mute": {
        const knowledgeId = args[1]?.trim();
        const sessionId = option(args, "--session");
        if (
          !knowledgeId ||
          knowledgeId.startsWith("--") ||
          !sessionId
        ) {
          io.error(usage);
          return 2;
        }
        const result = await withKnowledgeControl(
          root,
          (service) =>
            service.mute({
              knowledgeId,
              sessionId,
            }),
        );
        io.log(
          result.changed
            ? `All ProvenLoop context muted for Session ${sessionId} (requested via Knowledge ${knowledgeId}).`
            : `All ProvenLoop context is already muted for Session ${sessionId}.`,
        );
        return 0;
      }
      case "forget": {
        const targetId = args[1]?.trim();
        if (!targetId || targetId.startsWith("--")) {
          io.error(usage);
          return 2;
        }
        return runDeletionCommand(
          [
            "delete",
            "--knowledge",
            targetId,
            "--data-root",
            root,
          ],
          io,
        );
      }
    }
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 3;
  }
  io.error(usage);
  return 2;
};

const runKnowledgeReviewCommand = async (
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> => {
  const action = args[1];
  const writes = action === "confirm" || action === "replace" || action === "revoke";
  const values = ["--cwd", "--data-root", "--scope", "--workflow"];
  if (action === "list") {
    values.push("--state");
  }
  if (writes) {
    values.push("--expect", "--reason");
  }
  if (action === "confirm" || action === "replace") {
    values.push("--resolve");
  }
  if (action === "replace") {
    values.push("--content", "--when", "--not-when", "--purpose", "--topics", "--source", "--source-kind");
  }
  const discovery = action === "replace" ? discoveryOptions(args) : {};
  const state = option(args, "--state");
  const scope = scopeSchema.safeParse(option(args, "--scope") ?? "repository");
  const knowledgeId = args[2]?.trim();
  const expectedDigest = option(args, "--expect");
  if (
    !["list", "show", "confirm", "replace", "revoke"].includes(action ?? "") ||
    !scope.success ||
    !hasOnlyOptions(args, action === "list" ? 2 : 3, {
      flags: writes ? ["--confirm"] : [],
      values,
    }) ||
    (action !== "list" && (!knowledgeId || knowledgeId.startsWith("--"))) ||
    (state !== undefined && ![
      "candidate", "active", "disputed", "superseded", "archived",
    ].includes(state)) ||
    (writes && (
      !args.includes("--confirm") ||
      expectedDigest === undefined ||
      !/^[a-f0-9]{64}$/u.test(expectedDigest)
    )) ||
    (action === "replace" && (!option(args, "--content")?.trim() || discovery === undefined))
  ) {
    io.error(usage);
    return 2;
  }
  try {
    const root = dataRoot(args);
    const scopeId = await rememberScopeId(
      scope.data,
      args,
      dependencies.createAdapter(root),
      root,
    );
    const reviewScope = {
      scope: scope.data,
      ...(scopeId === undefined ? {} : { scopeId }),
    };
    return await withKnowledgeControl(root, async (service) => {
      if (action === "list") {
        io.log(JSON.stringify(service.list({
          ...reviewScope,
          ...(state === undefined ? {} : {
            state: state as KnowledgeCandidate["state"],
          }),
        }), null, 2));
        return 0;
      }
      if (action === "show") {
        io.log(JSON.stringify(service.review({
          ...reviewScope,
          knowledgeId: knowledgeId ?? "",
        }), null, 2));
        return 0;
      }
      const content = option(args, "--content");
      const when = option(args, "--when");
      const notWhen = option(args, "--not-when");
      const reason = option(args, "--reason");
      const resolvesEvidenceIds = option(args, "--resolve")?.split(",")
        .map((value) => value.trim()).filter(Boolean);
      if (action === "revoke") {
        await service.revoke({
          ...reviewScope,
          knowledgeId: knowledgeId ?? "",
          expectedDigest: expectedDigest ?? "",
          userConfirmed: true,
          ...(reason === undefined ? {} : { reason }),
        });
        io.log(`Knowledge ${knowledgeId} archived without deleting its review history.`);
        return 0;
      }
      const result = await service.resolve({
        ...reviewScope,
        knowledgeId: knowledgeId ?? "",
        expectedDigest: expectedDigest ?? "",
        userConfirmed: true,
        ...(resolvesEvidenceIds === undefined ? {} : { resolvesEvidenceIds }),
        ...(content === undefined ? {} : { content }),
        ...(when === undefined ? {} : { appliesWhen: [when] }),
        ...(notWhen === undefined ? {} : { nonApplicability: [notWhen] }),
        ...(reason === undefined ? {} : { reason }),
        ...(action === "replace" && discovery && Object.keys(discovery).length ? { replacementDiscovery: discovery } : {}),
      });
      io.log(`User-confirmed rule ${result.candidate?.knowledgeId} recorded; this is not external verification.`);
      return 0;
    }, scope.data === "workflow" ? scopeId : undefined);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 3;
  }
};

const runObservationsCommand = async (
  args: readonly string[],
  io: CliIo,
): Promise<number> => {
  const date = option(args, "--date");
  const sessionId = option(args, "--session")?.trim();
  const dateTime = date === undefined ? undefined : Date.parse(`${date}T00:00:00Z`);
  if (
    !["show", "export"].includes(args[1] ?? "") ||
    !hasOnlyOptions(args, 2, { values: ["--data-root", "--date", "--session"] }) ||
    (sessionId !== undefined && sessionId.length === 0) ||
    (args.includes("--data-root") && !option(args, "--data-root")?.trim()) ||
    (date !== undefined && (
      !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
      dateTime === undefined ||
      !Number.isFinite(dateTime) ||
      new Date(dateTime).toISOString().slice(0, 10) !== date
    ))
  ) {
    io.error(usage);
    return 2;
  }
  try {
    const input = {
      dataRoot: dataRoot(args),
      ...(date === undefined ? {} : { date }),
      ...(sessionId === undefined ? {} : { sessionId }),
    };
    const result = args[1] === "show"
      ? await readLocalObservationSummary(input)
      : await exportLocalObservationManifest({
          ...input,
          codeVersion: PROVENLOOP_CODE_VERSION,
        });
    io.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 3;
  }
};

const deletionTarget = (
  args: readonly string[],
):
  | {
      readonly targetId: string;
      readonly targetType:
        | "episode"
        | "knowledge"
        | "session"
        | "source";
    }
  | undefined => {
  const targets = [
    ["--source", "source"],
    ["--session", "session"],
    ["--episode", "episode"],
    ["--knowledge", "knowledge"],
  ] as const;
  const selected = targets.flatMap(([
    name,
    targetType,
  ]) => {
    const targetId = option(args, name);
    return args.includes(name) &&
      targetId !== undefined &&
      !targetId.startsWith("--")
      ? [
          {
            targetId,
            targetType,
          },
        ]
      : [];
  });
  return selected.length === 1 ? selected[0] : undefined;
};

const runDeletionCommand = async (
  args: readonly string[],
  io: CliIo,
  beforeDelete?: (store: CanonicalSqliteStore, queue: WindowsCaptureQueue) => Promise<void>,
): Promise<number> => {
  const target = deletionTarget(args);
  if (
    target === undefined ||
    !hasOnlyOptions(args, 1, {
      values: [
        "--data-root",
        "--episode",
        "--knowledge",
        "--session",
        "--source",
      ],
    }) ||
    [
      "--source",
      "--session",
      "--episode",
      "--knowledge",
    ].some((name) =>
      hasInvalidOptionValue(args, name),
    ) ||
    hasInvalidOptionValue(args, "--data-root")
  ) {
    io.error(usage);
    return 2;
  }
  const root = dataRoot(args);
  const paths = resolveWindowsProvenLoopPaths(root);
  const deletionId = `deletion-${randomUUID()}`;
  let knowledgeBackend: SqliteFtsKnowledgeBackend | undefined;
  let store: CanonicalSqliteStore | undefined;
  let projectionLease: Awaited<
    ReturnType<typeof acquireKnowledgeProjectionLease>
  > | undefined;
  let observationsLease: Awaited<
    ReturnType<typeof acquireKnowledgeProjectionLease>
  > | undefined;
  try {
    await access(paths.rootMarker);
    await access(paths.database);
    projectionLease = await acquireKnowledgeProjectionLease(
      paths.root,
    );
    observationsLease = await acquireMaintenanceLease(paths.root, "observations");
    const queue = new WindowsCaptureQueue(paths.queue);
    await queue.initialize();
    store = new CanonicalSqliteStore(paths.database);
    knowledgeBackend = new SqliteFtsKnowledgeBackend(
      paths.knowledgeDatabase,
    );
    const knowledgeProjection = new KnowledgeProjectionManager({
      backend: knowledgeBackend,
      store,
    });
    const ledgers = new Map<string, EvidenceLedgerWriter>();
    const result = await new DeletionService({
      transientCleanup: async () => {
        const inferenceLease = new WindowsNamedPipeLeaseProvider(await resolveWindowsProvenLoopLeaseName(paths.root, "learning-inference"));
        const deadline = Date.now() + 12_000;
        while (true) {
          await cancelLearningScratch(join(paths.root, "temp"));
          const lease = await inferenceLease.tryAcquire();
          if (lease) {
            try { await cancelLearningScratch(join(paths.root, "temp")); return; }
            finally { await lease.release(); }
          }
          if (Date.now() >= deadline) throw new Error("Inference shutdown has not completed; deletion remains pending.");
          await new Promise<void>((done) => setTimeout(done, 50));
        }
      },
      knowledgeProjection: {
        acquireLease: async () => ({
          release: async () => undefined,
        }),
        rebuild: async () => {
          await knowledgeProjection.rebuild();
        },
        remainingIdentifiers: async (identifiers) => {
          const remaining: string[] = [];
          for (const identifier of identifiers) {
            if (!identifier.startsWith("knowledge:")) {
              continue;
            }
            const backendIdentifier = identifier.slice(
              "knowledge:".length,
            );
            if (
              await knowledgeBackend?.get(backendIdentifier) !== undefined
            ) {
              remaining.push(identifier);
            }
          }
          return remaining;
        },
      },
      queue,
      recordEvidence: async (entry) => {
        let ledger = ledgers.get(entry.runId);
        if (ledger === undefined) {
          ledger = new EvidenceLedgerWriter(
            join(
              paths.evaluation,
              "deletions",
              entry.runId,
              "evidence-ledger.jsonl",
            ),
          );
          await ledger.initialize();
          ledgers.set(entry.runId, ledger);
        }
        await ledger.appendIfAbsent([
          entry,
        ]);
      },
      store,
    }).delete({
      deletionId,
      ...(beforeDelete ? { preflight: async () => { if (!store) throw new Error("Retention store is unavailable."); await beforeDelete(store, queue); } } : {}),
      ...target,
    });
    await invalidateLocalObservationProjection(paths.root);
    io.log(
      `${
        target.targetType === "knowledge"
          ? "Forget"
          : "Deletion"
      } completed: ${result.operation.deletedSourceCount} source identifiers, ` +
      `${result.operation.deletedDependentCount} dependent records, ` +
      `${result.operation.deletedQueueItemCount} queue items.`,
    );
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return error instanceof DeletionPropagationGateError ? 1 : 3;
  } finally {
    try {
      await knowledgeBackend?.closeAsync();
    } finally {
      try {
        store?.close();
      } finally {
        try {
          await observationsLease?.release();
        } finally {
          await projectionLease?.release();
        }
      }
    }
  }
};

const runEvaluationCommand = async (
  args: readonly string[],
  io: CliIo,
): Promise<number> => {
  if (args[1] === "m0") {
    const outputRoot = option(args, "--out");
    const evidencePath = option(args, "--evidence");
    if (
      !outputRoot ||
      outputRoot.startsWith("--") ||
      hasInvalidOptionValue(args, "--evidence")
    ) {
      io.error(usage);
      return 2;
    }
    try {
      const result = await runM0ReleaseGate({
        ...(evidencePath === undefined
          ? {}
          : {
              evidencePath,
            }),
        outputRoot,
        codeVersion: PROVENLOOP_CODE_VERSION,
      });
      io.log(
        `M0 release gate ${result.report.status}: ${result.runDirectory}`,
      );
      return result.report.exitCode;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return error instanceof M0AcceptanceEvidenceInputError
        ? 2
        : 3;
    }
  }
  if (args[1] === "m1") {
    const outputRoot = option(args, "--out");
    const datasetPath = option(args, "--dataset");
    if (
      !outputRoot ||
      outputRoot.startsWith("--") ||
      hasInvalidOptionValue(args, "--dataset")
    ) {
      io.error(usage);
      return 2;
    }
    try {
      const result = await runM1ReleaseGate({
        ...(datasetPath === undefined
          ? {}
          : {
              datasetPath,
            }),
        outputRoot,
        releaseTarget: args.includes("--stable")
          ? "stable"
          : "research",
      });
      io.log(
        `M1 release gate ${result.report.status}: ${result.runDirectory}`,
      );
      return result.report.exitCode;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 3;
    }
  }
  if (args[1] === "m2") {
    const outputRoot = option(args, "--out");
    const datasetPath = option(args, "--dataset");
    const automaticLearningEvidencePath = option(args, "--automatic-learning-evidence");
    if (
      !hasOnlyOptions(args, 2, {
        flags: [
          "--stable",
        ],
        values: [
          "--dataset",
          "--automatic-learning-evidence",
          "--out",
        ],
      }) ||
      !outputRoot ||
      outputRoot.startsWith("--") ||
      hasInvalidOptionValue(args, "--dataset") || hasInvalidOptionValue(args, "--automatic-learning-evidence")
    ) {
      io.error(usage);
      return 2;
    }
    try {
      const result = await runM2ReleaseGate({
        ...(automaticLearningEvidencePath === undefined ? {} : { automaticLearningEvidencePath }),
        ...(datasetPath === undefined
          ? {}
          : {
              datasetPath,
            }),
        outputRoot,
        releaseTarget: args.includes("--stable")
          ? "stable"
          : "research",
      });
      io.log(
        `M2 release gate ${result.report.status}: ${result.runDirectory}`,
      );
      return result.report.exitCode;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 3;
    }
  }
  if (args[1] === "mvp") {
    const outputRoot = option(args, "--out");
    const evidencePath = option(args, "--evidence");
    const automaticLearningEvidencePath = option(args, "--automatic-learning-evidence");
    if (
      !hasOnlyOptions(args, 2, {
        flags: [
          "--stable",
        ],
        values: [
          "--evidence",
          "--automatic-learning-evidence",
          "--out",
        ],
      }) ||
      !outputRoot ||
      outputRoot.startsWith("--") ||
      hasInvalidOptionValue(args, "--evidence") || hasInvalidOptionValue(args, "--automatic-learning-evidence")
    ) {
      io.error(usage);
      return 2;
    }
    try {
      const result = await runMvpReleaseGate({
        ...(automaticLearningEvidencePath === undefined ? {} : { automaticLearningEvidencePath }),
        ...(evidencePath === undefined
          ? {}
          : {
              evidencePath,
            }),
        outputRoot,
        codeVersion: PROVENLOOP_CODE_VERSION,
        releaseTarget: args.includes("--stable")
          ? "stable"
          : "research",
      });
      io.log(
        `MVP release decision ${result.report.decision}: ${result.runDirectory}`,
      );
      return result.report.exitCode;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return error instanceof MvpReleaseInputError ? 2 : 3;
    }
  }
  if (args[1] === "episodes") {
    if (hasInvalidOptionValue(args, "--dataset")) {
      io.error(usage);
      return 2;
    }
    try {
      const datasetPath = option(args, "--dataset");
      const report = evaluateEpisodeAssociationDataset(
        await loadEpisodeAssociationDataset(datasetPath),
      );
      io.log(renderEpisodeAssociationReport(report));
      return report.status === "pass" ? 0 : 1;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (args[1] === "run") {
    const suite = option(args, "--suite");
    const outputRoot = option(args, "--out");
    if (!suite || !outputRoot) {
      io.error(usage);
      return 2;
    }

    try {
      const result = await runEvaluation({
        outputRoot,
        suite,
      });
      io.log(
        `Evaluation ${result.report.status}: ${result.runDirectory}`,
      );
      return result.report.exitCode;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 3;
    }
  }

  if (args[1] === "report") {
    const run = option(args, "--run");
    if (!run) {
      io.error(usage);
      return 2;
    }

    try {
      const result = await regenerateMarkdownReport(run);
      io.log(result.markdown);
      return result.report.exitCode;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return error instanceof EvaluationReportInputError ? 2 : 3;
    }
  }

  io.error(usage);
  return 2;
};

const runWorkerCommand = async (
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> => {
  const rawBatchSize = option(args, "--batch-size");
  const batchSize =
    rawBatchSize === undefined ? 100 : Number(rawBatchSize);
  if (
    args[1] !== "run" ||
    hasInvalidOptionValue(args, "--batch-size") ||
    hasInvalidOptionValue(args, "--data-root") ||
    !Number.isInteger(batchSize) ||
    batchSize <= 0
  ) {
    io.error(usage);
    return 2;
  }
  try {
    const result = await (
      dependencies.runWorker ?? runCaptureWorkerOnce
    )({
      batchSize,
      dataRoot: dataRoot(args),
    });
    io.log(JSON.stringify(result, null, 2));
    return result.status === "circuit_open" ||
      (
        result.status === "completed" &&
        (
          result.failed > 0 ||
          result.circuitOpenReasons.length > 0
        )
      )
      ? 1
      : 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 3;
  }
};

const runAcceptanceCommand = async (
  args: readonly string[],
  io: CliIo,
): Promise<number> => {
  if (args[1] === "start") {
    if (
      hasInvalidOptionValue(args, "--session-root") ||
      hasInvalidOptionValue(args, "--data-root") ||
      !hasOnlyOptions(args, 2, {
        values: [
          "--data-root",
          "--session-root",
        ],
      })
    ) {
      io.error(usage);
      return 2;
    }
    try {
      const sessionRoot = option(args, "--session-root");
      const result = await startM0DailyAcceptance({
        dataRoot: dataRoot(args),
        ...(sessionRoot === undefined
          ? {}
          : {
              sessionRoot,
            }),
      });
      io.log(
        `M0 daily acceptance started: ${result.runDirectory}`,
      );
      return 0;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 3;
    }
  }
  if (args[1] === "complete") {
    const rawTimeout = option(args, "--drain-timeout");
    const timeoutSeconds =
      rawTimeout === undefined ? 30 : Number(rawTimeout);
    if (
      hasInvalidOptionValue(args, "--drain-timeout") ||
      hasInvalidOptionValue(args, "--data-root") ||
      !Number.isFinite(timeoutSeconds) ||
      timeoutSeconds <= 0 ||
      !hasOnlyOptions(args, 2, {
        values: [
          "--data-root",
          "--drain-timeout",
        ],
      })
    ) {
      io.error(usage);
      return 2;
    }
    try {
      const result = await completeM0DailyAcceptance({
        dataRoot: dataRoot(args),
        drainTimeoutMs: timeoutSeconds * 1_000,
      });
      io.log(
        `M0 daily acceptance ${result.status}: ${result.runDirectory}`,
      );
      return result.status === "fail" ? 1 : 0;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 3;
    }
  }
  io.error(usage);
  return 2;
};

const runCollectionCommand = async (
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> => {
  if (
    ![
      "disable",
      "enable",
    ].includes(args[1] ?? "") ||
    hasInvalidOptionValue(args, "--data-root") ||
    !hasOnlyOptions(args, 2, {
      values: [
        "--data-root",
      ],
    })
  ) {
    io.error(usage);
    return 2;
  }
  try {
    const adapter = dependencies.createAdapter(dataRoot(args));
    if (args[1] === "enable") io.log(AUTOMATIC_LEARNING_DISCLOSURE);
    const operation = args[1] === "enable"
      ? adapter.enable.bind(adapter)
      : adapter.disable.bind(adapter);
    for (const capability of [
      "capture",
      "worker",
    ] as const) {
      const result = await operation(capability);
      if (result.status === "incompatible") {
        io.error(result.message);
        return 1;
      }
    }
    io.log(
      args[1] === "enable"
        ? "Automatic collection enabled."
        : "Automatic collection disabled.",
    );
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 3;
  }
};

const runLearningCommand = async (args: readonly string[], io: CliIo): Promise<number> => {
  const action = args[1];
  if (action === "approve-hooks") {
    const cwd = option(args, "--cwd");
    if (!cwd || hasInvalidOptionValue(args, "--cwd") ||
        !hasOnlyOptions(args, 2, { values: ["--cwd"], flags: ["--confirm"] })) { io.error(usage); return 2; }
    io.log(`This grants plugin:provenloop:event-capture access to Copilot session hooks in ${resolve(cwd)}. Hooks can observe prompts and tool calls and supply verified guidance. The grant persists in Copilot for this repository.`);
    if (!args.includes("--confirm")) { io.error("Approve this repository-scoped host permission with --confirm."); return 2; }
    try {
      io.log(JSON.stringify(await approveCopilotLearningHooks({ cwd: resolve(cwd) }), null, 2));
      io.log("Restart the Copilot session to load the approved hooks.");
      return 0;
    } catch (error) { io.error(error instanceof Error ? error.message : String(error)); return 3; }
  }
  if (!["status", "enable", "disable", "mute", "unmute"].includes(action ?? "") ||
      hasInvalidOptionValue(args, "--data-root") ||
      (action === "status" && hasInvalidOptionValue(args, "--cwd")) ||
      !hasOnlyOptions(args, 2, { values: action === "status" ? ["--data-root", "--cwd"] : ["--data-root"], flags: ["--confirm"] })) {
    io.error(usage); return 2;
  }
  if (action === "enable") {
    io.log(AUTOMATIC_LEARNING_DISCLOSURE);
  }
  try {
    const paths = resolveWindowsProvenLoopPaths(dataRoot(args));
    await access(paths.rootMarker);
    const lease = await acquireMaintenanceLease(paths.root, "adapter-state");
    try {
      const now = new Date();
      const state = await readCopilotAdapterState(paths.adapterState, now);
      if (action === "status") {
        await access(paths.database);
        const store = new CanonicalSqliteStore(paths.database);
        let jobs;
        let discoveryEnrichment;
        try {
          discoveryEnrichment = store.discoveryEnrichmentStatus();
          jobs = store.learningJobs().map((job) => ({
            jobId: job.jobId, state: job.state, attempts: job.attempts, result: job.result,
            createdAt: job.createdAt, updatedAt: job.updatedAt, expiresAt: job.expiresAt,
            pauseReason: job.pauseReason, retryAfter: job.retryAfter,
            failureKind: job.failureKind, preflightFailures: job.preflightFailures, inputBudgetRecovery: job.inputBudgetRecovery,
            distillation: job.distillation,
          }));
        } finally { store.close(); }
        io.log(JSON.stringify({
          automaticLearning: resolveAutomaticLearning(state),
          prerequisites: resolveAutomaticLearning(state).prerequisites,
          readiness: await readLearningReadiness(state, { cwd: option(args, "--cwd") ?? process.cwd(), dataRoot: paths.root }),
          disclosure: AUTOMATIC_LEARNING_DISCLOSURE,
          hostHooks: { ...getCopilotAutomaticLearningHostCapability(state.detectedCopilotVersion),
            permission: "extension-permission-access", extension: "plugin:provenloop:event-capture",
            detail: "Copilot must approve this extension in each repository before automatic retrieval hooks can start. Background learning does not grant host permissions." },
          jobs,
          discoveryEnrichment,
        }, null, 2));
        return 0;
      }
      const previous = state.automaticLearning ?? {
        notificationsEnabled: true,
      };
      const automaticLearning = { ...previous,
        ...(action === "enable" ? { enabled: true } : action === "disable" ? { enabled: false } : {}),
        notificationsEnabled: action === "mute" ? false : action === "unmute" ? true : previous.notificationsEnabled,
      };
      const next = { ...state, automaticLearning, updatedAt: now.toISOString() };
      await writeCopilotAdapterState(paths.adapterState, next);
      io.log(JSON.stringify({ automaticLearning: resolveAutomaticLearning(next) }, null, 2));
      if (action === "enable") io.log("Copilot also requires repository-scoped hook approval. Run provenloop learning approve-hooks --cwd <repository-directory> --confirm, then restart the Copilot session. Automatic reuse is unavailable until the host grants this permission.");
      return 0;
    } finally { await lease.release(); }
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error)); return 3;
  }
};

export const runCli = async (
  args: readonly string[],
  io: CliIo = defaultIo,
  dependencies: CliDependencies = defaultDependencies,
): Promise<number> => {
  if (args[0] === "records") {
    if (args[1] !== "clear" || !hasOnlyOptions(args, 2, { values: ["--data-root"], flags: ["--confirm"] })) { io.error(usage); return 2; }
    try {
      const root = dataRoot(args);
      if (!args.includes("--confirm")) {
        io.log(JSON.stringify(await previewRecordsReset(root), null, 2));
        io.log("Clears all recorded activity, knowledge, episodes, learning jobs, usage, queues and local record artifacts. Installation and configuration are retained. Run again with --confirm to clear; restart Copilot afterward.");
        return 0;
      }
      io.log(JSON.stringify(await resetAllRecords({ dataRoot: root, confirmed: true }), null, 2));
      io.log("All records cleared. Installation and configuration were preserved. Restart Copilot to resume collection; old captured history will not be imported again.");
      return 0;
    } catch (error) { io.error(error instanceof Error ? error.message : String(error)); return 3; }
  }
  if (args[0] === "capture" && args[1] === "retention") {
    const action = args[2];
    const apply = action === "apply";
    if (!["plan", "apply"].includes(action ?? "") || !hasOnlyOptions(args, 3, {
      values: ["--data-root", "--older-than", ...(apply ? ["--expect", "--sessions"] : [])], flags: apply ? ["--confirm"] : [],
    })) { io.error(usage); return 2; }
    const cutoff = option(args, "--older-than");
    if ((cutoff !== undefined && !Number.isFinite(Date.parse(cutoff))) || (apply && (!cutoff || !args.includes("--confirm")))) {
      io.error("Apply requires the reviewed cutoff, digest, selected session IDs, and --confirm."); return 2;
    }
    const root = dataRoot(args);
    const paths = resolveWindowsProvenLoopPaths(root);
    let store: CanonicalSqliteStore | undefined;
    let captureLease: Awaited<ReturnType<typeof acquireMaintenanceLease>> | undefined;
    try {
      await access(paths.rootMarker); await access(paths.database);
      if (apply) captureLease = await acquireMaintenanceLease(root, "capture-worker");
      store = new CanonicalSqliteStore(paths.database);
      const olderThan = cutoff ? new Date(cutoff) : undefined;
      if (!apply) {
        io.log(JSON.stringify(planCaptureRetention(store, olderThan ? { olderThan } : {}), null, 2)); return 0;
      }
      const checkedCutoff = new Date(cutoff ?? "");
      const result = await applyCaptureRetention(store, { olderThan: checkedCutoff, expectedDigest: option(args, "--expect") ?? "",
        sessionIds: (option(args, "--sessions") ?? "").split(",").map((id) => id.trim()).filter(Boolean), userConfirmed: true }, async (sessionId) => {
        const code = await runDeletionCommand(["delete", "--session", sessionId, "--data-root", root], io, async (current, queue) => {
          if ((await queue.list()).some((item) => item.envelope.event.sessionId === sessionId && item.state !== "acknowledged")) {
            throw new Error("Session has pending or failed capture work. Drain and review it before retention cleanup.");
          }
          if (!planCaptureRetention(current, { olderThan: checkedCutoff }).candidates.some((entry) => entry.sessionId === sessionId)) {
            throw new Error("Session acquired new activity or dependencies after review. Create a new retention plan.");
          }
        });
        if (code !== 0) throw new Error("Session cleanup did not complete; inspect deletion status before retrying.");
      });
      io.log(JSON.stringify(result, null, 2)); return 0;
    } catch (error) { io.error(error instanceof Error ? error.message : String(error)); return 3; }
    finally { store?.close(); await captureLease?.release(); }
  }
  if (args[0] === "learning") return runLearningCommand(args, io);
  if (args[0] === "ui") {
    const port = option(args, "--port");
    if (!hasOnlyOptions(args, 1, { flags: ["--no-open"], values: ["--port", "--data-root"] }) ||
      (port !== undefined && (!/^\d{1,5}$/u.test(port) || Number(port) > 65535))) {
      io.error(usage); return 2;
    }
    try {
      await runUi({ dataRoot: dataRoot(args), port: Number(port ?? 0), open: !args.includes("--no-open") }, io);
      return 0;
    } catch (error) { io.error(error instanceof Error ? error.message : String(error)); return 1; }
  }
  if (args[0] === "version" && args.length === 1) {
    io.log(JSON.stringify(releaseMetadata, null, 2));
    return 0;
  }
  if (
    args[0] === "runtime" &&
    args[1] === "extension-path" &&
    args.length === 2
  ) {
    io.log(
      fileURLToPath(new URL("./extension-entry.js", import.meta.url)),
    );
    return 0;
  }
  if (args[0] === "eval") {
    return runEvaluationCommand(args, io);
  }
  if (args[0] === "acceptance") {
    return runAcceptanceCommand(args, io);
  }
  if (args[0] === "observations") {
    return runObservationsCommand(args, io);
  }
  if (args[0] === "collection") {
    return runCollectionCommand(args, io, dependencies);
  }
  if (args[0] === "delete") {
    return runDeletionCommand(args, io);
  }
  if (args[0] === "knowledge") {
    return runKnowledgeReviewCommand(args, io, dependencies);
  }
  if (
    [
      "correct",
      "forget",
      "mute",
      "remember",
    ].includes(args[0] ?? "")
  ) {
    return runKnowledgeControlCommand(
      args,
      io,
      dependencies,
    );
  }
  if (args[0] === "worker") {
    return runWorkerCommand(args, io, dependencies);
  }
  if (args[0] === "mcp" && args[1] === "serve") {
    if (hasInvalidOptionValue(args, "--data-root")) {
      io.error(usage);
      return 2;
    }
    try {
      await dependencies.runMcpServer({
        dataRoot: dataRoot(args),
      });
      return 0;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 3;
    }
  }
  if (
    args[0] === "purge" &&
    !hasOnlyOptions(args, 1, {
      values: [
        "--data-root",
      ],
    })
  ) {
    io.error(usage);
    return 2;
  }
  if (
    args[0] === "install" &&
    !hasOnlyOptions(args, 1, {
      flags: [
        "--no-auto-collect",
      ],
      values: [
        "--data-root",
      ],
    })
  ) {
    io.error(usage);
    return 2;
  }
  if (
    args[0] === "doctor" &&
    !hasOnlyOptions(args, 1, {
      flags: [
        "--online",
      ],
      values: [
        "--data-root",
      ],
    })
  ) {
    io.error(usage);
    return 2;
  }
  if (
    args[0] === "uninstall" &&
    !hasOnlyOptions(args, 1, {
      flags: [
        "--purge",
      ],
      values: [
        "--data-root",
      ],
    })
  ) {
    io.error(usage);
    return 2;
  }
  if (
    ![
      "disable",
      "delete",
      "doctor",
      "enable",
      "install",
      "purge",
      "status",
      "uninstall",
      "upgrade",
    ].includes(args[0] ?? "")
  ) {
    io.error(usage);
    return 2;
  }
  if (hasInvalidOptionValue(args, "--data-root")) {
    io.error(usage);
    return 2;
  }

  try {
    const adapter = dependencies.createAdapter(dataRoot(args));
    switch (args[0]) {
      case "install": {
        io.log(AUTOMATIC_LEARNING_DISCLOSURE);
        const result = await adapter.install(
          args.includes("--no-auto-collect")
            ? {
                autoCollect: false,
              }
            : undefined,
        );
        io.log(result.message);
        if (operationExitCode(result) === 0) {
          const root = dataRoot(args);
          const quotedRoot = `'${root.replaceAll("'", "''")}'`;
          io.log(`Check automatic reuse in your repository: provenloop learning status --cwd <repository-directory> --data-root ${quotedRoot}. Follow its next steps for collection, extraction and repository hook approval, then restart Copilot in that repository.`);
          try {
            const state = await readCopilotAdapterState(resolveWindowsProvenLoopPaths(root).adapterState, new Date());
            if (state.installed) {
              const readiness = await readLearningReadiness(state, { cwd: process.cwd(), dataRoot: root });
              io.log(`Current repository: ${readiness.repositoryPath ?? "No Git repository found"}. Collection: ${readiness.capture.status}. Extraction: ${readiness.extraction.status}. Automatic reuse: ${readiness.automaticReuse.status}.`);
              for (const step of readiness.nextSteps) io.log(step);
            }
          } catch {
            io.log("Repository readiness could not be checked. Run the status command above from your repository before starting Copilot.");
          }
        }
        return operationExitCode(result);
      }
      case "upgrade": {
        io.log(AUTOMATIC_LEARNING_DISCLOSURE);
        const result = await adapter.upgrade();
        io.log(result.message);
        return operationExitCode(result);
      }
      case "status":
        io.log(JSON.stringify(await adapter.status(), null, 2));
        return 0;
      case "doctor": {
        const health = await adapter.doctor({
          online: args.includes("--online"),
        });
        io.log(JSON.stringify(health, null, 2));
        return health.status === "healthy"
          ? 0
          : health.status === "degraded"
            ? 1
            : 3;
      }
      case "enable":
      case "disable": {
        const capability = provenLoopCapabilitySchema.safeParse(
          args[1],
        );
        if (!capability.success) {
          io.error(usage);
          return 2;
        }
        if (args[0] === "enable" && ["capture", "worker", "correction_learning"].includes(capability.data)) io.log(AUTOMATIC_LEARNING_DISCLOSURE);
        const result =
          args[0] === "enable"
            ? await adapter.enable(capability.data)
            : await adapter.disable(capability.data);
        io.log(result.message);
        return operationExitCode(result);
      }
      case "uninstall": {
        const result = await adapter.uninstall({
          purge: args.includes("--purge"),
        });
        io.log(result.message);
        return operationExitCode(result);
      }
      case "purge": {
        const result = await adapter.uninstall({
          purge: true,
        });
        io.log(result.message);
        return operationExitCode(result);
      }
    }
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 3;
  }
  io.error(usage);
  return 2;
};
