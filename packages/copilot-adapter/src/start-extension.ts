import {
  isProvenLoopInternalEnvironment,
  sanitizeDiagnostic,
} from "@provenloop/domain";

import {
  AsyncCaptureWriter,
  type CaptureQueueSink,
} from "./async-writer.js";
import {
  BoundedCaptureBuffer,
  type BoundedCaptureBufferOptions,
} from "./capture-buffer.js";
import {
  CopilotEventMapper,
  type CopilotCallbackCopyLimits,
  type CopilotSessionEvent,
  type CopilotWorkspaceSnapshot,
} from "./event-mapper.js";
import {
  CopilotExtensionCapture,
  type CopilotSessionLike,
} from "./extension-runtime.js";

export interface StartCopilotExtensionCaptureOptions {
  readonly adapterVersion: string;
  readonly buffer: BoundedCaptureBufferOptions;
  readonly copyLimits: CopilotCallbackCopyLimits;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly enabled?: boolean;
  readonly internalSessionIds?: ReadonlySet<string>;
  readonly joinSession: (
    options: {
      readonly onEvent: (event: CopilotSessionEvent) => void;
      readonly refreshWorkspace: () => void;
    },
  ) => Promise<CopilotSessionLike>;
  readonly onDiagnostic?: (message: string) => void;
  readonly onStopped?: () => Promise<void> | void;
  readonly onWorkspaceChanged?: (
    workspace: CopilotWorkspaceSnapshot,
    source: "session" | "refresh",
  ) => void;
  readonly onWorkspaceRefreshStarted?: () => void;
  readonly queue: CaptureQueueSink;
  readonly refreshWorkspace?: (workspace: CopilotWorkspaceSnapshot) => Promise<CopilotWorkspaceSnapshot>;
  readonly retryDelayMs: number;
  readonly sessionId: string;
  readonly shutdownDeadlineMs: number;
  readonly signalSource?: CaptureTerminationSignalSource;
  readonly terminate?: (exitCode: number) => void;
  readonly workspace?: CopilotWorkspaceSnapshot;
}

export interface CaptureTerminationSignalSource {
  once(signal: "SIGTERM", listener: () => void): unknown;
}

export const startCopilotExtensionCapture = async (
  options: StartCopilotExtensionCaptureOptions,
): Promise<CopilotExtensionCapture> => {
  const internalSession =
    isProvenLoopInternalEnvironment(
      options.environment ?? process.env,
    ) ||
    (options.internalSessionIds?.has(options.sessionId) ?? false);
  const mapper = new CopilotEventMapper({
    adapterVersion: options.adapterVersion,
    copyLimits: options.copyLimits,
    sessionId: options.sessionId,
    ...(options.workspace === undefined
      ? {}
      : {
          workspace: options.workspace,
        }),
  });
  const writer = new AsyncCaptureWriter({
    buffer: new BoundedCaptureBuffer(options.buffer),
    ...(options.onDiagnostic === undefined
      ? {}
      : {
          onError: options.onDiagnostic,
        }),
    queue: options.queue,
    retryDelayMs: options.retryDelayMs,
  });
  const runtime = new CopilotExtensionCapture({
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    internalSession,
    mapper,
    ...(options.onDiagnostic === undefined
      ? {}
      : {
          onDiagnostic: options.onDiagnostic,
        }),
    ...(options.onStopped === undefined
      ? {}
      : {
          onStopped: options.onStopped,
        }),
    ...(options.onWorkspaceChanged === undefined ? {} : { onWorkspaceChanged: options.onWorkspaceChanged }),
    ...(options.onWorkspaceRefreshStarted === undefined ? {} : {
      onWorkspaceRefreshStarted: options.onWorkspaceRefreshStarted,
    }),
    ...(options.refreshWorkspace === undefined
      ? {}
      : {
          refreshWorkspace: options.refreshWorkspace,
        }),
    shutdownDeadlineMs: options.shutdownDeadlineMs,
    writer,
  });
  const signalSource = options.signalSource ?? process;
  const terminate =
    options.terminate ??
    ((exitCode: number) => {
      process.exit(exitCode);
    });
  let joinedSession: CopilotSessionLike | undefined;
  signalSource.once("SIGTERM", () => {
    let terminated = false;
    const terminateOnce = (): void => {
      if (terminated) {
        return;
      }
      terminated = true;
      terminate(0);
    };
    const terminationTimer = setTimeout(
      terminateOnce,
      options.shutdownDeadlineMs,
    );
    void runtime.shutdown()
      .then(async () => {
        await joinedSession?.disconnect?.();
      })
      .catch((error: unknown) => {
        try {
          options.onDiagnostic?.(sanitizeDiagnostic(error));
        } catch {
          // Diagnostics cannot prevent extension termination.
        }
      })
      .finally(() => {
        clearTimeout(terminationTimer);
        terminateOnce();
      });
  });
  try {
    joinedSession = await options.joinSession({
      onEvent: (event) => {
        runtime.receive(event);
      },
      refreshWorkspace: () => runtime.refreshWorkspace(),
    });
  } catch (error) {
    await runtime.shutdown();
    throw error;
  }
  runtime.start();
  if (
    !internalSession &&
    options.workspace === undefined &&
    options.refreshWorkspace !== undefined
  ) {
    runtime.refreshWorkspace();
  }
  return runtime;
};
