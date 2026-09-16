import { CopilotLearningProvider, getCopilotAutomaticLearningHostCapability, hasCopilotLearningHookApproval,
  readCopilotAdapterState, resolveAutomaticLearning, SpawnCommandRunner,
  type CommandRunner, type PersistedCopilotAdapterState } from "@provenloop/copilot-adapter";
import type { LearningToolContract } from "@provenloop/contracts";
import { DiscoveryEnrichmentCoordinator, LearningCoordinator } from "@provenloop/host";
import { isUpgradeMaintenanceActive, isExtensionShutdownRequested, resolveWindowsProvenLoopPaths, resolveWindowsProvenLoopLeaseName, WindowsNamedPipeLeaseProvider } from "@provenloop/platform-windows";
import { CanonicalSqliteStore } from "@provenloop/storage-sqlite";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { writeFile } from "node:fs/promises";
import { KnowledgeProjectionManager, SqliteFtsKnowledgeBackend } from "@provenloop/retrieval";

// Configuration and repository permission checks do not prove that a running session loaded hooks.
export async function readLearningReadiness(state: PersistedCopilotAdapterState, options: {
  readonly cwd?: string; readonly copilotHome?: string; readonly dataRoot?: string; readonly runner?: CommandRunner;
} = {}) {
  const workingDirectory = resolve(options.cwd ?? process.cwd());
  const git = await (options.runner ?? new SpawnCommandRunner()).run("git", ["-C", workingDirectory, "rev-parse", "--show-toplevel"], { timeoutMs: 5_000 });
  const repositoryPath = git.exitCode === 0 && git.stdout.trim() ? resolve(git.stdout.trim()) : undefined;
  const host = getCopilotAutomaticLearningHostCapability(state.detectedCopilotVersion);
  const hookApproval = !repositoryPath ? "repository_unknown" as const : host.status === "unverified" ? "unverified" as const
    : await hasCopilotLearningHookApproval(options.copilotHome ?? process.env.COPILOT_HOME ?? join(homedir(), ".copilot"),
      repositoryPath, state.detectedCopilotVersion ?? "") ? "approved" as const : "missing" as const;
  const learning = resolveAutomaticLearning(state);
  const installationBlockedBy = [
    ...(!state.installed ? ["not_installed"] : []),
    ...(!state.pluginInstalled || !state.pluginEnabled ? ["plugin_unavailable"] : []),
  ];
  const captureBlockedBy = [...installationBlockedBy, ...(["capture", "worker"] as const)
    .filter((name) => !state.capabilities[name].enabled).map((name) => `${name}_disabled`)];
  const extractionBlockedBy = [...installationBlockedBy, ...learning.blockedBy];
  const reuseBlockedBy = [...extractionBlockedBy,
    ...(!state.capabilities.retrieval.enabled ? ["retrieval_disabled"] : []),
    ...(!repositoryPath ? ["repository_unknown"] : []),
    ...(host.status === "unverified" ? ["copilot_version_unverified"] : []),
    ...(hookApproval === "missing" ? ["repository_hook_approval_missing"] : []),
  ];
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const rootOption = options.dataRoot ? ` --data-root ${quote(options.dataRoot)}` : "";
  const nextSteps: string[] = [];
  if (installationBlockedBy.length) nextSteps.push(`Run provenloop install${rootOption} to restore the Copilot integration.`);
  if (!state.capabilities.capture.enabled || !state.capabilities.worker.enabled) nextSteps.push(`Enable collection with provenloop collection enable${rootOption}.`);
  if (!state.capabilities.correction_learning.enabled) nextSteps.push(`Enable extraction with provenloop enable correction_learning${rootOption}.`);
  if (learning.mode === "disabled") nextSteps.push(`Automatic learning is opted out. To resume, run provenloop learning enable${rootOption}.`);
  if (!state.capabilities.retrieval.enabled) nextSteps.push(`Enable guidance delivery with provenloop enable retrieval${rootOption}.`);
  if (!repositoryPath) nextSteps.push("Open a Git repository and run provenloop learning status from its root directory.");
  if (host.status === "unverified") nextSteps.push(`Run copilot --version and provenloop doctor${rootOption} to inspect the host. Automatic hook support is unverified for the last detected version; check compatibility before approving hooks.`);
  if (hookApproval === "missing" && repositoryPath) nextSteps.push(`Approve ProvenLoop hooks for this repository with provenloop learning approve-hooks --cwd ${quote(repositoryPath)} --confirm. This grants persistent access to session prompts and tool calls.`);
  if (repositoryPath && host.status !== "unverified") nextSteps.push("Restart Copilot in this repository after changing integration settings or approving hooks. Existing sessions may still have hooks disabled.");
  nextSteps.push(`Complete a real task, then open provenloop ui${rootOption} to inspect the extracted rule and its source. Try a related task and check Usage for guidance provided; explicit adoption is recorded separately.`);
  return {
    workingDirectory, repositoryPath: repositoryPath ?? null, lastDetectedCopilotVersion: state.detectedCopilotVersion ?? null,
    configurationUpdatedAt: state.updatedAt,
    capture: { status: captureBlockedBy.length ? "blocked" as const : "configured" as const, blockedBy: captureBlockedBy },
    extraction: { status: extractionBlockedBy.length ? "blocked" as const : "eligible" as const, blockedBy: extractionBlockedBy },
    automaticReuse: { status: reuseBlockedBy.length ? "blocked" as const : "configured_for_next_session" as const,
      blockedBy: [...new Set(reuseBlockedBy)], hookApproval, sessionHooks: "unverified" as const },
    detail: "Readiness uses saved installation settings and current repository permission records. It does not verify a running Copilot session, successful extraction, or guidance use.",
    nextSteps,
  };
}

export type LearningReadiness = Awaited<ReturnType<typeof readLearningReadiness>>;

export async function runLearningOnce(options: { readonly dataRoot: string; readonly contracts: readonly LearningToolContract[]; readonly signal?: AbortSignal }) {
  const paths = resolveWindowsProvenLoopPaths(options.dataRoot);
  const enabled = async (): Promise<boolean> => {
    const state = await readCopilotAdapterState(paths.adapterState, new Date());
    return !options.signal?.aborted && !await isExtensionShutdownRequested(paths.root) && !await isUpgradeMaintenanceActive(paths.root) && resolveAutomaticLearning(state).enabled;
  };
  if (!await enabled()) return { status: "disabled" as const };
  // Maintenance excludes the complete database lifetime, including post-inference projection.
  const lease = await new WindowsNamedPipeLeaseProvider(await resolveWindowsProvenLoopLeaseName(paths.root, "learning-inference")).tryAcquire();
  if (!lease) return { status: "busy" as const };
  let store: CanonicalSqliteStore | undefined;
  try {
    if (!await enabled()) return { status: "disabled" as const };
    store = new CanonicalSqliteStore(paths.database);
    const provider = new CopilotLearningProvider({ temporaryRoot: join(paths.root, "temp"), enabled });
    const result = await new LearningCoordinator({ store, enabled,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      provider,
      lease: { tryAcquire: async () => ({ release: async () => undefined }) },
      contracts: () => options.contracts,
    }).run();
    const enrichment = result.status === "idle" ? await new DiscoveryEnrichmentCoordinator({ store, provider, enabled,
      ...(options.signal === undefined ? {} : { signal: options.signal }) }).run() : undefined;
    if (result.status === "evaluated" && (result.proposals ?? 0) > 0 || enrichment?.status === "accepted") {
      await writeFile(paths.projectionDirty, JSON.stringify({ schemaVersion: 1, markedAt: new Date().toISOString() }) + "\n", "utf8");
      const projectionLease = await new WindowsNamedPipeLeaseProvider(
        await resolveWindowsProvenLoopLeaseName(paths.root, "knowledge-projection"),
      ).tryAcquire();
      if (projectionLease) {
        let backend: SqliteFtsKnowledgeBackend | undefined;
        try {
          if (await enabled() && !store.hasActiveDeletion()) {
            backend = new SqliteFtsKnowledgeBackend(paths.knowledgeDatabase);
            await new KnowledgeProjectionManager({ store, backend }).synchronize();
          }
        } finally {
          await backend?.closeAsync();
          await projectionLease.release();
        }
      }
    }
    const learned = store.pendingLearningActivationIds();
    return { ...result, learned, ...(enrichment ? { enrichment } : {}) };
  } finally {
    try { store?.close(); } finally { await lease.release(); }
  }
}

export async function notifyLearningActivation(dataRoot: string, ids: readonly string[], log: (message: string) => Promise<void>): Promise<boolean> {
  const paths = resolveWindowsProvenLoopPaths(dataRoot);
  if (await isUpgradeMaintenanceActive(paths.root)) return false;
  const lease = await new WindowsNamedPipeLeaseProvider(await resolveWindowsProvenLoopLeaseName(paths.root, "knowledge-projection")).tryAcquire();
  if (!lease) return false;
  let store: CanonicalSqliteStore | undefined;
  const claimed: string[] = [];
  try {
    if (await isUpgradeMaintenanceActive(paths.root)) return false;
    store = new CanonicalSqliteStore(paths.database);
    const state = await readCopilotAdapterState(paths.adapterState, new Date());
    const learning = resolveAutomaticLearning(state);
    if (!learning.enabled || !learning.notificationsEnabled || store.hasActiveDeletion()) return false;
    for (const id of ids) {
      if (store.claimLearningActivationNotice(id)) claimed.push(id);
      if (claimed.length >= 3) break;
    }
    if (claimed.length === 0) return false;
    const controls = claimed.map((id) => {
      const rule = store?.knowledgeCandidates([id])[0];
      const rootOption = `--data-root "${dataRoot}"`;
      const assessment = rule?.state === "candidate" && rule.evidenceTier === "inferred"
        ? "Model-reviewed lesson; external verification and user confirmation have not been recorded."
        : "Externally verified tool-invocation rule.";
      return `${assessment}\n${rule?.content ?? id}${rule?.appliesWhen.length ? `\nWhen it applies: ${rule.appliesWhen.join("; ")}` : ""}${rule?.nonApplicability.length ? `\nExceptions: ${rule.nonApplicability.join("; ")}` : ""}\nSource: provenloop knowledge show ${id} ${rootOption}. Undo after review: provenloop knowledge revoke ${id} --expect <review-digest> --confirm ${rootOption}. Delete: provenloop forget ${id} ${rootOption}.`;
    });
    await log(`ProvenLoop learned ${claimed.length} reusable lesson(s).\n${controls.join("\n\n")}`);
    return true;
  } catch (error) {
    for (const id of claimed) store?.releaseLearningActivationNotice(id);
    throw error;
  } finally { store?.close(); await lease.release(); }
}
