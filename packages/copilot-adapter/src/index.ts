export {
  AsyncCaptureWriter,
  InvalidCaptureWriterConfigurationError,
  type AsyncCaptureWriterOptions,
  type CaptureHealthState,
  type CaptureQueueSink,
  type CaptureWriterStatus,
} from "./async-writer.js";
export { CopilotLearningProvider, LearningProviderError } from "./learning-provider.js";
export { SupervisedInferenceRunner, cancelLearningScratch } from "./inference-supervisor.js";
export { getCopilotAutomaticLearningHostCapability, hasCopilotLearningHookApproval, approveCopilotLearningHooks } from "./automatic-host-capability.js";
export { CopilotLearningToolRegistry, type CopilotToolMetadata } from "./learning-tool-registry.js";
export {
  COPILOT_CAPTURE_CAPABILITIES,
  COPILOT_SUPPORTED_SOURCE_EVENT_TYPES,
  getCopilotCaptureCapability,
} from "./capabilities.js";
export {
  assertCopilotAdapterDataRoot,
  CopilotCliAdapter,
  CopilotCommandError,
  registerInternalCopilotSession,
  unregisterInternalCopilotSession,
  type CopilotCliAdapterOptions,
} from "./copilot-cli-adapter.js";
export {
  SpawnCommandRunner,
  type CommandResult,
  type CommandRunner,
  type CommandRunOptions,
} from "./command-runner.js";
export {
  BoundedCaptureBuffer,
  captureGapEvent,
  InvalidCaptureBufferConfigurationError,
  type BoundedCaptureBufferOptions,
  type CaptureBufferOfferResult,
  type CaptureBufferOfferStatus,
  type CaptureGap,
} from "./capture-buffer.js";
export {
  CaptureReconciler,
  captureEnvelopeCompleteness,
  type CanonicalCaptureWatermark,
  type CaptureReconcilerOptions,
  type CaptureReconciliationResult,
  type ReconcileSessionFileOptions,
  type ReconciliationQueue,
} from "./capture-reconciler.js";
export {
  CopilotEventMapper,
  InvalidCopilotEventMapperConfigurationError,
  type CopilotCallbackCopyLimits,
  type CopilotEventMapperOptions,
  type CopilotEventMappingResult,
  type CopilotSessionEvent,
  type CopilotWorkspaceSnapshot,
} from "./event-mapper.js";
export type {
  CaptureEvidence,
  CaptureQuality,
  RepositoryState,
} from "./capture-evidence.js";
export {
  CopilotExtensionCapture,
  InvalidExtensionCaptureConfigurationError,
  type CopilotExtensionCaptureOptions,
  type CopilotExtensionCaptureStatus,
  type CopilotSessionLike,
} from "./extension-runtime.js";
export {
  startCopilotExtensionCapture,
  type CaptureTerminationSignalSource,
  type StartCopilotExtensionCaptureOptions,
} from "./start-extension.js";
export {
  runInstalledCopilotExtension,
  type InstalledCopilotExtensionOptions,
  type InstalledCopilotExtensionResult,
} from "./extension-entry.js";
export {
  InvalidSessionFileParserConfigurationError,
  SessionFileBudgetError,
  parseCopilotSessionFile,
  type CopilotSessionEventSource,
  type CopilotSessionFileCursor,
  type CopilotSessionFileHeader,
  type CopilotSessionFileIssue,
  type CopilotSessionFileParserOptions,
  type CopilotSessionFileParseResult,
  type SessionFileStopReason,
} from "./session-file-parser.js";
export {
  createDefaultCopilotAdapterState,
  AUTOMATIC_LEARNING_DISCLOSURE,
  resolveAutomaticLearning,
  type AutomaticLearningConsent,
  type AutomaticLearningPreferences,
  readInternalSessionIds,
  readCopilotAdapterState,
  setPersistedCapability,
  writeCopilotAdapterState,
  type PersistedCapabilityState,
  type PersistedCopilotAdapterState,
} from "./operational-state.js";
export {
  readTrustedSessionContext,
  TrustedSessionContextPublisher,
  type TrustedSessionContext,
  type TrustedSessionContextDiagnostic,
  type TrustedSessionContextPublisherOptions,
  type TrustedSessionWorkspace,
} from "./trusted-session-context.js";
export { stopPluginProcesses } from "./stop-plugin-processes.js";
