import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { isoTimestampSchema } from "@provenloop/contracts";
import { sanitizeDiagnostic, sha256 } from "@provenloop/domain";

import {
  ExtensionShutdownRequestedError,
  isExtensionShutdownRequested,
  registerActiveExtension,
  resolveWindowsProvenLoopPaths,
  WindowsCaptureQueue,
} from "@provenloop/platform-windows";

import { getCopilotCaptureCapability } from "./capabilities.js";
import type { CommandRunner } from "./command-runner.js";
import {
  assertCopilotAdapterDataRoot,
  CopilotCliAdapter,
} from "./copilot-cli-adapter.js";
import type { CopilotSessionLike } from "./extension-runtime.js";
import { CopilotLearningToolRegistry } from "./learning-tool-registry.js";
import { getCopilotAutomaticLearningHostCapability, hasCopilotLearningHookApproval } from "./automatic-host-capability.js";
import { recoverPermissionBridges } from "./permission-bridge-recovery.js";
import { homedir } from "node:os";
import type { LearningToolContract } from "@provenloop/contracts";
import type { CopilotSessionEvent, CopilotWorkspaceSnapshot } from "./event-mapper.js";
import { readCopilotAdapterState, resolveAutomaticLearning } from "./operational-state.js";
import { startCopilotExtensionCapture, type CaptureTerminationSignalSource } from "./start-extension.js";
import {
  TrustedSessionContextPublisher,
  type TrustedSessionContext,
  type TrustedSessionWorkspace,
} from "./trusted-session-context.js";

export interface InstalledCopilotExtensionOptions {
  readonly commandRunner?: CommandRunner;
  readonly copilotHome?: string;
  readonly dataRoot: string;
  readonly environment?: Readonly<
    Record<string, string | undefined>
  >;
  readonly joinSession: (config?: { readonly hooks?: {
    readonly onUserPromptSubmitted?: (input: { readonly prompt: string; readonly sessionId: string; readonly workingDirectory: string }) => Promise<{ additionalContext?: string } | undefined>;
    readonly onPreToolUse?: (input: { readonly toolName: string; readonly toolArgs: unknown; readonly sessionId: string; readonly workingDirectory: string }) => Promise<{ additionalContext?: string } | undefined>;
    readonly onPostToolUse?: (input: { readonly toolName: string; readonly toolArgs: unknown; readonly sessionId: string; readonly toolResult: { readonly resultType: string } }) => Promise<void>;
    readonly onPostToolUseFailure?: (input: { readonly toolName: string; readonly toolArgs: unknown; readonly sessionId: string; readonly error: string }) => Promise<void>;
  } }) => Promise<CopilotSessionLike>;
  readonly onAutomaticContext?: (input: { readonly prompt?: string; readonly toolArguments?: unknown; readonly tool?: LearningToolContract; readonly shellTool?: { readonly toolName: "powershell" | "bash"; readonly command: string; readonly cwd: string }; readonly workspace: CopilotWorkspaceSnapshot; readonly sessionId: string }) => Promise<string | undefined>;
  readonly now?: () => Date;
  readonly onStopping?: () => Promise<void> | void;
  readonly onStopped?: () => void;
  readonly workflowScopeId?: string;
  readonly signalSource?: CaptureTerminationSignalSource;
  readonly terminate?: (exitCode: number) => void;
}

export type InstalledCopilotExtensionResult =
  | {
      readonly status: "disabled" | "incompatible";
    }
  | {
      readonly status: "failed";
      readonly error: string;
    }
  | {
      readonly status: "started";
      readonly hostSession?: CopilotSessionLike;
      readonly toolRegistry?: CopilotLearningToolRegistry;
      readonly captureSession?: {
        readonly sessionId: string;
        readonly sessionStateRoot: string;
        readonly minimumTimestamp: string;
      };
    };

const appendDiagnostic = async (
  path: string,
  message: string,
): Promise<void> => {
  await mkdir(dirname(path), {
    recursive: true,
  });
  await appendFile(
    path,
    `${JSON.stringify({
      message,
      timestamp: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
};

const writeCaptureMetrics = async (
  path: string,
  value: unknown,
): Promise<void> => {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), {
    recursive: true,
  });
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(value)}\n`,
      "utf8",
    );
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};

const humanMessage = (
  event: CopilotSessionEvent,
): NonNullable<TrustedSessionContext["latestUserMessage"]> | undefined => {
  if (event === null || typeof event !== "object" ||
      event.type !== "user.message" || event.agentId !== undefined) {
    return undefined;
  }
  const data = event.data !== null && typeof event.data === "object" && !Array.isArray(event.data)
    ? event.data as Readonly<Record<string, unknown>> : undefined;
  if ((data?.isAutopilotContinuation !== undefined && data.isAutopilotContinuation !== false) ||
      (data?.source !== undefined && data.source !== "user")) {
    return undefined;
  }
  const copy = (value: string): string => Buffer.from(value, "utf8").toString("utf8");
  const timestamp = typeof event.timestamp === "string" && event.timestamp.length <= 64 &&
    isoTimestampSchema.safeParse(event.timestamp).success ? copy(event.timestamp) : "";
  const eventId = typeof event.id === "string" && event.id.length <= 256 ? copy(event.id) : "";
  return {
    eventId,
    timestamp,
    text: eventId.trim().length > 0 && timestamp.length > 0 &&
      typeof data?.content === "string" && data.content.length <= 96
      ? copy(data.content) : "",
  };
};

const observedRepositoryState = (identity: {
  readonly repositoryId?: string;
  readonly repositoryState?: unknown;
}): NonNullable<TrustedSessionWorkspace["repositoryState"]> => {
  if (identity.repositoryState === "unknown" || identity.repositoryState === "known_outside_repo") {
    return identity.repositoryState;
  }
  if (identity.repositoryState !== undefined && identity.repositoryState !== "known_repo") return "unknown";
  return typeof identity.repositoryId === "string" && identity.repositoryId.length > 0 ? "known_repo" : "unknown";
};

export const runInstalledCopilotExtension = async (
  options: InstalledCopilotExtensionOptions,
): Promise<InstalledCopilotExtensionResult> => {
  const now = options.now ?? (() => new Date());
  const environment = options.environment ?? process.env;
  const paths = resolveWindowsProvenLoopPaths(options.dataRoot);
  let runtimeActive = true;
  let extensionRegistration:
    | Awaited<ReturnType<typeof registerActiveExtension>>
    | undefined;
  let metricsTimer: NodeJS.Timeout | undefined;
  let dataRootVerified = false;
  let sdkSession: CopilotSessionLike | undefined;
  const toolRegistry = new CopilotLearningToolRegistry();
  const pendingTools = new Map<string, { name: string; argumentDigest: string; mcp: NonNullable<import("@provenloop/contracts").RawEvent["mcp"]> }>();
  let captureSession: Extract<InstalledCopilotExtensionResult, { status: "started" }>["captureSession"];
  let disconnecting: Promise<void> | undefined;
  let stopPublishing: () => Promise<void> = async () => undefined;
  let stopping: Promise<void> | undefined;
  const disconnectSession = (): Promise<void> => {
    if (sdkSession === undefined) return Promise.resolve();
    const session = sdkSession;
    disconnecting ??= Promise.resolve().then(async () => {
      await session.disconnect?.();
    });
    return disconnecting;
  };
  const releaseExtensionRegistration = async (): Promise<void> => {
    await extensionRegistration?.release();
    extensionRegistration = undefined;
  };
  const diagnostic = (message: string): void => {
    if (!runtimeActive) {
      return;
    }
    void appendDiagnostic(
      join(paths.logs, "extension.jsonl"),
      sanitizeDiagnostic(message),
    ).catch(() => undefined);
  };
  const stopRuntime = (): Promise<void> => {
    stopping ??= (async () => {
      runtimeActive = false;
      if (metricsTimer !== undefined) {
        clearInterval(metricsTimer);
        metricsTimer = undefined;
      }
      // Retain registration until background database users have cancelled and closed.
      await options.onStopping?.();
      try {
        await stopPublishing();
      } finally {
        try {
          await disconnectSession();
        } finally {
          try {
            await releaseExtensionRegistration();
          } finally {
            options.onStopped?.();
          }
        }
      }
    })();
    return stopping;
  };
  try {
    await assertCopilotAdapterDataRoot(paths);
    dataRootVerified = true;
    const state = await readCopilotAdapterState(paths.adapterState, now());
    if (!state.installed ||
        (!state.capabilities.capture.enabled && !state.capabilities.retrieval.enabled)) {
      runtimeActive = false;
      return { status: "disabled" };
    }
    const sessionId = environment.SESSION_ID?.trim();
    if (!sessionId) {
      throw new Error("SESSION_ID is unavailable to the Extension.");
    }
    extensionRegistration = await registerActiveExtension(
      paths.root,
      sessionId,
      {
        assertDataRoot: () =>
          assertCopilotAdapterDataRoot(paths),
      },
    );
    const adapter = new CopilotCliAdapter({
      ...(options.commandRunner === undefined
        ? {}
        : {
            commandRunner: options.commandRunner,
          }),
      ...(options.copilotHome === undefined
        ? {}
        : {
            copilotHome: options.copilotHome,
          }),
      dataRoot: options.dataRoot,
      environment,
      now,
    });
    const capabilities = await adapter.capabilities();
    const adapterVersion = capabilities.installedVersion;
    if (
      capabilities.compatibility !== "supported" ||
      adapterVersion === undefined ||
      getCopilotCaptureCapability(adapterVersion) === undefined
    ) {
      diagnostic(
        `Copilot version ${adapterVersion ?? "unknown"} is incompatible.`,
      );
      await releaseExtensionRegistration();
      return {
        status: "incompatible",
      };
    }
    const identity = await adapter.resolveSession({
      adapterVersion,
      cwd: process.cwd(),
      environment,
      sessionId,
    });
    if (identity.internalSession) {
      await releaseExtensionRegistration();
      return {
        status: "disabled",
      };
    }
    const queue = new WindowsCaptureQueue(paths.queue, { onDiagnostic: diagnostic });
    const learning = resolveAutomaticLearning(state);
    const hooksEnabled = learning.enabled &&
      await hasCopilotLearningHookApproval(options.copilotHome ?? environment.COPILOT_HOME ?? join(homedir(), ".copilot"),
        identity.worktreePath ?? process.cwd(), adapterVersion);
    const quoteCommandArgument = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    const statusCommand = `provenloop learning status --cwd ${quoteCommandArgument(identity.worktreePath ?? process.cwd())} --data-root ${quoteCommandArgument(paths.root)}`;
    const reuseBlocker = !learning.enabled || hooksEnabled ? undefined
      : getCopilotAutomaticLearningHostCapability(adapterVersion).status === "unverified"
        ? `Automatic reuse is unavailable in this session: Copilot ${adapterVersion} has not been verified for ProvenLoop hooks. Run ${statusCommand} to check supported setup. Collection and extraction can continue.`
        : observedRepositoryState(identity) !== "known_repo"
          ? `Automatic reuse needs a Git repository. Open Copilot in a repository, run ${statusCommand}, and follow its setup steps.`
          : `Automatic reuse is paused for this repository. Run provenloop learning approve-hooks --cwd ${quoteCommandArgument(identity.worktreePath ?? process.cwd())} --confirm, then restart Copilot here. This grants persistent access to session prompts and tool calls. Collection and extraction can continue. Check setup: ${statusCommand}.`;
    if (reuseBlocker) diagnostic(reuseBlocker);
    let queueReady: Promise<void> | undefined;
    const initializeQueue = (): Promise<void> => {
      queueReady ??= queue.initialize().catch((error: unknown) => {
        queueReady = undefined;
        throw error;
      });
      return queueReady;
    };
    const initialRepositoryState = observedRepositoryState(identity);
    let workspace: CopilotWorkspaceSnapshot = {
      cwd: process.cwd(),
      ...(initialRepositoryState !== "known_repo" || identity.branch === undefined ? {} : { branch: identity.branch }),
      ...(initialRepositoryState !== "known_repo" || identity.commitSha === undefined ? {} : { commitSha: identity.commitSha }),
      ...(initialRepositoryState !== "known_repo" || identity.commitParents === undefined ? {} : { commitParents: identity.commitParents }),
      ...(initialRepositoryState !== "known_repo" || identity.repositoryId === undefined ? {} : { repoId: identity.repositoryId }),
      ...(identity.worktreePath === undefined ? {} : { worktree: identity.worktreePath }),
      ...(options.workflowScopeId === undefined ? {} : { workflowScopeId: options.workflowScopeId }),
      repositoryState: initialRepositoryState,
    };
    let publisher: TrustedSessionContextPublisher | undefined;
    let publisherStarting: Promise<void> | undefined;
    let publisherStopping = Promise.resolve();
    let lastMessage: NonNullable<TrustedSessionContext["latestUserMessage"]> | undefined;
    let contextAccepting = true;
    let workspaceRefreshing = false;
    let lastRefreshAt = now().getTime();
    let publishedCwd: string | undefined;
    const trustedWorkspace = (snapshot: CopilotWorkspaceSnapshot): TrustedSessionWorkspace => {
      const observedCwd = snapshot.cwd ?? snapshot.worktree ?? process.cwd();
      if (!isAbsolute(observedCwd)) throw new Error("Trusted SDK workspace must be absolute.");
      const cwd = resolve(observedCwd);
      const stableCwd = publishedCwd !== undefined &&
        publishedCwd.toLowerCase() === cwd.toLowerCase() ? publishedCwd : cwd;
      const repositoryState = observedRepositoryState({
        ...(snapshot.repoId === undefined ? {} : { repositoryId: snapshot.repoId }),
        ...(snapshot.repositoryState === undefined ? {} : { repositoryState: snapshot.repositoryState }),
      });
      return {
        cwd: stableCwd,
        repositoryState,
        ...(repositoryState !== "known_repo" || snapshot.repoId === undefined ? {} : { repositoryId: snapshot.repoId }),
        ...(repositoryState !== "known_repo" || snapshot.branch === undefined ? {} : { branch: snapshot.branch }),
        ...(repositoryState !== "known_repo" || snapshot.commitSha === undefined ? {} : { commitSha: snapshot.commitSha }),
        ...(snapshot.workflowScopeId === undefined ? {} : { workflowScopeId: snapshot.workflowScopeId }),
      };
    };
    const failPublisher = (failed: TrustedSessionContextPublisher, error: unknown): void => {
      diagnostic(`Trusted Session context failed: ${sanitizeDiagnostic(error)}`);
      if (publisher === failed) publisher = undefined;
      publisherStopping = publisherStopping.then(() => failed.stop()).catch((stopError: unknown) => {
        diagnostic(`Trusted Session context cleanup failed: ${sanitizeDiagnostic(stopError)}`);
      });
    };
    const ensurePublisher = async (): Promise<void> => {
      if (!runtimeActive || !contextAccepting || publisher !== undefined) return;
      if (publisherStarting !== undefined) return publisherStarting;
      publisherStarting = (async () => {
        await publisherStopping;
        if (!runtimeActive || !contextAccepting) return;
        const initial = trustedWorkspace(workspace);
        const next = new TrustedSessionContextPublisher({
          ...initial,
          dataRoot: paths.root,
          sessionId,
          now,
          onError: (error) => failPublisher(next, error),
        });
        try {
          await next.start();
          if (!runtimeActive || !contextAccepting) {
            await next.stop();
            return;
          }
          publisher = next;
          const current = trustedWorkspace(workspace);
          next.updateWorkspace(current);
          publishedCwd = current.cwd;
          if (workspaceRefreshing) next.beginWorkspaceRefresh();
          if (lastMessage !== undefined) next.observeUserMessage(lastMessage);
          lastMessage = undefined;
          await next.flush();
        } catch (error) {
          if (publisher === next) publisher = undefined;
          await next.stop().catch(() => undefined);
          throw error;
        }
      })();
      try {
        await publisherStarting;
      } finally {
        publisherStarting = undefined;
      }
    };
    stopPublishing = async (): Promise<void> => {
      contextAccepting = false;
      lastMessage = undefined;
      await publisherStarting?.catch(() => undefined);
      await publisherStopping;
      const active = publisher;
      publisher = undefined;
      await active?.stop();
    };
    const observeWorkspace = (snapshot: CopilotWorkspaceSnapshot, source: "session" | "refresh"): void => {
      workspace = snapshot;
      workspaceRefreshing = source === "session" || snapshot.repositoryState === "unknown";
      if (source === "session") lastMessage = undefined;
      if (!runtimeActive || !contextAccepting || publisher === undefined) return;
      try {
        const next = trustedWorkspace(snapshot);
        if (source === "session" || next.repositoryState === "unknown") {
          workspaceRefreshing = true;
          if (next.cwd !== publishedCwd) {
            publisher.updateWorkspace({
              cwd: next.cwd,
              repositoryState: "unknown",
              ...(next.workflowScopeId === undefined ? {} : { workflowScopeId: next.workflowScopeId }),
            });
            publishedCwd = next.cwd;
          }
          publisher.beginWorkspaceRefresh();
        } else {
          workspaceRefreshing = false;
          publisher.updateWorkspace(next);
          publishedCwd = next.cwd;
        }
      } catch (error) {
        failPublisher(publisher, error);
      }
    };
    const capture = await startCopilotExtensionCapture({
      adapterVersion,
      enabled: state.capabilities.capture.enabled,
      buffer: {
        maxBytes: 1024 * 1024,
        maxGapBytes: 128 * 1024,
        maxGapContexts: 64,
        maxItems: 1_000,
      },
      copyLimits: {
        maxStringChars: 32_768,
      },
      environment,
      joinSession: async ({ onEvent, refreshWorkspace }) => {
        const automaticContext = async (input: { readonly prompt?: string; readonly toolName?: string; readonly toolArgs?: unknown; readonly sessionId: string; readonly workingDirectory: string }): Promise<{ additionalContext?: string } | undefined> => {
          if (!runtimeActive || input.sessionId !== sessionId || resolve(input.workingDirectory).toLowerCase() !== resolve(workspace.cwd ?? "").toLowerCase()) return;
          try {
            let builtinShell = false;
            if (input.toolName !== undefined && sdkSession?.rpc?.tools !== undefined) {
              let timer: NodeJS.Timeout | undefined;
              const metadata = await Promise.race([sdkSession.rpc.tools.getCurrentMetadata(), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 100); })]).finally(() => clearTimeout(timer));
              if (metadata === undefined || metadata.tools === null) return;
              toolRegistry.replace(metadata.tools, adapterVersion);
              builtinShell = metadata.tools?.some((entry) => entry.name === input.toolName &&
                (entry.name === "powershell" || entry.name === "bash") &&
                entry.mcpServerName === undefined && entry.mcpToolName === undefined) === true;
            }
            const tool = input.toolName === undefined ? undefined : toolRegistry.find(input.toolName);
            const args = input.toolArgs !== null && typeof input.toolArgs === "object" && !Array.isArray(input.toolArgs)
              ? input.toolArgs as Readonly<Record<string, unknown>> : {};
            const shellTool: { toolName: "powershell" | "bash"; command: string; cwd: string } | undefined = builtinShell && (input.toolName === "powershell" || input.toolName === "bash") &&
              typeof args.command === "string" && args.command.length <= 256
              ? { toolName: input.toolName, command: args.command, cwd: typeof args.cwd === "string" ? resolve(input.workingDirectory, args.cwd) : input.workingDirectory } : undefined;
            const context = await options.onAutomaticContext?.({ sessionId, workspace,
              ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
              ...(shellTool === undefined ? {} : { shellTool }),
              ...(tool === undefined ? {} : { tool, toolArguments: input.toolArgs }) });
            if (runtimeActive && context) return { additionalContext: context };
          } catch (error) { diagnostic(`Automatic context unavailable: ${sanitizeDiagnostic(error)}`); }
          return undefined;
        };
        const recordToolResult = async (input: { readonly toolName: string; readonly toolArgs: unknown; readonly sessionId: string; readonly error?: string }, resultType: "success" | "failure"): Promise<void> => {
          if (input.sessionId !== sessionId) return;
          let active = true; let timer: NodeJS.Timeout | undefined;
          const replay = (event: CopilotSessionEvent): void => {
            if(active && ["permission.requested","permission.completed","hook.start","hook.end"].includes(String(event.type)))
              onEvent({id:event.id,type:event.type,parentId:event.parentId,timestamp:event.timestamp,data:{}});
          };
          const recovery = sdkSession?.rpc?.eventLog !== undefined
            ? sdkSession.rpc.eventLog.read({direction:"backward",max:128,types:["permission.requested","permission.completed","hook.start","hook.end"],includeEphemeral:false,waitMs:0})
              .then((result) => { for(const event of result.events.slice(-128)) replay(event); })
            : recoverPermissionBridges(sdkSession?.workspacePath, sessionId, replay);
          try { await Promise.race([recovery,
            new Promise<void>((resolve) => {timer=setTimeout(resolve,100);})]); } catch { diagnostic("Permission parent recovery unavailable; verification remains pending."); }
          finally { active=false; clearTimeout(timer); }
          const matches = [...pendingTools.values()].filter((entry) => entry.name === input.toolName && entry.argumentDigest === sha256(input.toolArgs));
          if (matches.length !== 1 || !matches[0]) return;
          const match = matches[0];
          const argument = input.error?.slice(0, 1024).match(/(?:missing required (?:argument|parameter|property)[: ]+["']?([A-Za-z_][A-Za-z0-9_]*)|required (?:argument|parameter|property) ["']([A-Za-z_][A-Za-z0-9_]*)["'] (?:is )?missing)/iu);
          match.mcp = { ...match.mcp, resultType, ...((argument?.[1] ?? argument?.[2]) === undefined ? {} : { failureArgument: argument?.[1] ?? argument?.[2] }) };
        };
        const session = await options.joinSession(hooksEnabled ? { hooks: {
          onUserPromptSubmitted: automaticContext, onPreToolUse: automaticContext,
          onPostToolUse: async (input) => { if (input.toolResult.resultType === "success") await recordToolResult(input, "success"); },
          onPostToolUseFailure: (input) => recordToolResult(input, "failure"),
        } } : undefined);
        sdkSession = session;
        if (!runtimeActive) {
          await disconnectSession();
          return { on: (listener) => session.on(listener), disconnect: disconnectSession };
        }
        if (session.sessionId !== undefined && session.sessionId !== sessionId) {
          throw new Error("Joined SDK Session does not match SESSION_ID.");
        }
        if (reuseBlocker && learning.notificationsEnabled && session.log) {
          void session.log(`ProvenLoop: ${reuseBlocker}`, { level: "warning", ephemeral: true })
            .catch((error: unknown) => diagnostic(`Setup notice unavailable: ${sanitizeDiagnostic(error)}`));
        }
        if (
          session.sessionId === sessionId &&
          typeof session.workspacePath === "string" &&
          isAbsolute(session.workspacePath) &&
          basename(resolve(session.workspacePath)).toLowerCase() === sessionId.toLowerCase()
        ) {
          captureSession = {
            sessionId,
            sessionStateRoot: dirname(resolve(session.workspacePath)),
            minimumTimestamp: now().toISOString(),
          };
        } else {
          diagnostic("SDK Session workspace is unavailable; automatic capture reconciliation is disabled.");
        }
        session.on((event) => {
          try {
            if (event?.type === "session.shutdown") contextAccepting = false;
            if (runtimeActive && contextAccepting) {
              const message = humanMessage(event);
              if (message !== undefined) {
                workspaceRefreshing = true;
                publisher?.beginWorkspaceRefresh();
                refreshWorkspace();
                if (publisher !== undefined) {
                  publisher.observeUserMessage(message);
                } else if (publisherStarting !== undefined) {
                  lastMessage = message;
                }
              }
            }
            const data = event.data !== null && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
            const contract = typeof data.toolName === "string" ? toolRegistry.find(data.toolName) : undefined;
            if (event.type === "tool.execution_start" && contract && typeof data.toolCallId === "string") {
              if (pendingTools.size >= 256) pendingTools.clear();
              pendingTools.set(data.toolCallId, { name: String(data.toolName), argumentDigest: sha256(data.arguments), mcp: { serverName: contract.serverName, toolName: contract.toolName, contractDigest: contract.digest } });
            }
            const pending = typeof data.toolCallId === "string" ? pendingTools.get(data.toolCallId) : undefined;
            onEvent(pending === undefined ? event : { ...event, mcp: pending.mcp });
            if (event.type === "tool.execution_complete" && typeof data.toolCallId === "string") pendingTools.delete(data.toolCallId);
          } catch (error) {
            diagnostic(`SDK event handling failed: ${sanitizeDiagnostic(error)}`);
          }
        });
        try {
          await ensurePublisher();
        } catch (error) {
          if (!state.capabilities.capture.enabled) throw error;
          diagnostic(`Trusted Session context startup failed: ${sanitizeDiagnostic(error)}`);
        }
        return {
          on: (listener) => session.on(listener),
          disconnect: disconnectSession,
        };
      },
      onDiagnostic: diagnostic,
      onStopped: stopRuntime,
      onWorkspaceChanged: observeWorkspace,
      onWorkspaceRefreshStarted: () => {
        lastRefreshAt = now().getTime();
        workspaceRefreshing = true;
        publisher?.beginWorkspaceRefresh();
      },
      queue: {
        enqueue: async (input, enqueueOptions) => {
          await initializeQueue();
          return queue.enqueue(input, enqueueOptions);
        },
        enqueueIfSourceAbsent: async (input, enqueueOptions) => {
          await initializeQueue();
          return queue.enqueueIfSourceAbsent(input, enqueueOptions);
        },
      },
      refreshWorkspace: async (workspace) => {
        const refreshed = await adapter.resolveSession({
          adapterVersion,
          cwd: workspace.cwd ?? workspace.worktree ?? process.cwd(),
          environment,
          sessionId,
        });
        const repositoryState = observedRepositoryState(refreshed);
        return {
          cwd: workspace.cwd ?? workspace.worktree ?? process.cwd(),
          ...(workspace.workflowScopeId === undefined ? {} : { workflowScopeId: workspace.workflowScopeId }),
          repositoryState,
          ...(repositoryState !== "known_repo" || refreshed.branch === undefined
            ? {}
            : {
                branch: refreshed.branch,
              }),
          ...(repositoryState !== "known_repo" || refreshed.commitParents === undefined
            ? {}
            : {
                commitParents: refreshed.commitParents,
              }),
          ...(repositoryState !== "known_repo" || refreshed.commitSha === undefined
            ? {}
            : {
                commitSha: refreshed.commitSha,
              }),
          ...(repositoryState !== "known_repo" || refreshed.repositoryId === undefined
            ? {}
            : {
                repoId: refreshed.repositoryId,
              }),
          ...(refreshed.worktreePath === undefined
            ? {}
            : {
                worktree: refreshed.worktreePath,
              }),
        };
      },
      retryDelayMs: 1_000,
      sessionId,
      shutdownDeadlineMs: 5_000,
      workspace,
      ...(options.signalSource === undefined ? {} : { signalSource: options.signalSource }),
      ...(options.terminate === undefined ? {} : { terminate: options.terminate }),
    });
    if (!runtimeActive || !contextAccepting) {
      await capture.shutdown();
      return { status: "disabled" };
    }
    capture.refreshWorkspace();
    const sessionDigest = createHash("sha256")
      .update(sessionId)
      .digest("hex")
      .slice(0, 24);
    const metricsPath = join(
      paths.evaluation,
      "capture-metrics",
      `${sessionDigest}.json`,
    );
    let metricsFlushRunning = false;
    const flushMetrics = async (): Promise<void> => {
      if (metricsFlushRunning || !runtimeActive) {
        return;
      }
      metricsFlushRunning = true;
      let latest: Awaited<
        ReturnType<typeof readCopilotAdapterState>
      >;
      try {
        if (await isExtensionShutdownRequested(paths.root)) {
          contextAccepting = false;
          capture.setEnabled(false);
          await capture.shutdown();
          metricsFlushRunning = false;
          return;
        }
        latest = await readCopilotAdapterState(
          paths.adapterState,
          now(),
        );
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        ) {
          diagnostic(
            `Capture capability refresh failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        runtimeActive = false;
        contextAccepting = false;
        capture.setEnabled(false);
        if (metricsTimer !== undefined) {
          clearInterval(metricsTimer);
          metricsTimer = undefined;
        }
        await capture.shutdown().catch(() => false);
        metricsFlushRunning = false;
        return;
      }
      if (!latest.installed ||
          (!latest.capabilities.capture.enabled && !latest.capabilities.retrieval.enabled)) {
        contextAccepting = false;
        capture.setEnabled(false);
        if (metricsTimer !== undefined) {
          clearInterval(metricsTimer);
          metricsTimer = undefined;
        }
        await capture.shutdown().catch(() => false);
        metricsFlushRunning = false;
        return;
      }
      capture.setEnabled(latest.capabilities.capture.enabled);
      try {
        await ensurePublisher();
        if (now().getTime() - lastRefreshAt >= 30_000) capture.refreshWorkspace();
        if (latest.capabilities.capture.enabled) {
          await writeCaptureMetrics(metricsPath, {
            schemaVersion: 1,
            sessionIdDigest: sessionDigest,
            status: capture.status(),
            timestamp: now().toISOString(),
          });
        }
      } catch (error) {
        if (runtimeActive) {
          diagnostic(
            `Extension state publication failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } finally {
        metricsFlushRunning = false;
      }
    };
    metricsTimer = setInterval(() => {
      void flushMetrics();
    }, 1_000);
    metricsTimer.unref();
    void flushMetrics();
    return {
      status: "started",
      ...(sdkSession === undefined ? {} : { hostSession: sdkSession }),
      toolRegistry,
      ...(captureSession === undefined ? {} : { captureSession }),
    };
  } catch (error) {
    const message = sanitizeDiagnostic(error);
    if (error instanceof ExtensionShutdownRequestedError) {
      await stopRuntime().catch(() => undefined);
      return {
        status: "disabled",
      };
    }
    if (dataRootVerified) diagnostic(message);
    await stopRuntime().catch(() => undefined);
    return {
      error: message,
      status: "failed",
    };
  }
};
