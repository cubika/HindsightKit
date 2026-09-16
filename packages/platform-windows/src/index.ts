export {
  CaptureQueueItemNotFoundError,
  CaptureQueueLeaseTimeoutError,
  CaptureQueueNotInitializedError,
  CaptureQueueDeletionInProgressError,
  ConflictingCaptureQueueDeletionError,
  CorruptCaptureQueueItemError,
  DuplicateQueueItemIdError,
  DeletedCaptureSourceError,
  InvalidCaptureQueueConfigurationError,
  InvalidCaptureQueueTransitionError,
  InvalidQueueItemIdError,
  StaleCaptureQueueClaimError,
  WindowsCaptureQueue,
  type EnqueueCaptureIfAbsentResult,
  type CaptureQueueClaim,
  type CaptureQueueIssue,
  type CaptureQueueIdentity,
  type DeleteCaptureQueueResult,
  type DeleteCaptureQueueOptions,
  type EnqueueCaptureOptions,
  type WindowsCaptureQueueOptions,
} from "./capture-queue.js";
export {
  discoverCopilotSessionFiles,
  InvalidSessionDiscoveryConfigurationError,
  resolveCopilotSessionStateRoot,
  type CopilotSessionFileDescriptor,
  type DiscoverCopilotSessionFilesOptions,
} from "./copilot-session-files.js";
export {
  beginExtensionShutdown,
  ExtensionShutdownRequestedError,
  ExtensionShutdownTimeoutError,
  isExtensionShutdownRequested,
  registerActiveExtension,
  waitForActiveExtensionsToStop,
  type ActiveExtensionRegistration,
  type ExtensionShutdownBarrier,
  type RegisterActiveExtensionOptions,
} from "./extension-lifecycle.js";
export {
  WindowsNamedPipeLeaseProvider,
  windowsNamedPipePath,
  type ProcessLease,
  type ProcessLeaseProvider,
} from "./process-lease.js";
export {
  LocalAppDataUnavailableError,
  resolveWindowsCaptureWorkerLeaseName,
  resolveWindowsProvenLoopDataRoot,
  resolveWindowsProvenLoopLeaseName,
  resolveWindowsProvenLoopPaths,
  type WindowsProvenLoopPaths,
} from "./operational-paths.js";
export { beginUpgradeMaintenance, isUpgradeMaintenanceActive, waitForMaintenanceLease } from "./upgrade-maintenance.js";
export { isRecordsResetPending, recordsResetPendingPath } from "./record-reset.js";
