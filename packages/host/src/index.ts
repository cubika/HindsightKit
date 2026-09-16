export {
  BranchContextProjector,
  type BranchContextProjectionResult,
  type BranchContextProjectionStore,
  type BranchContextProjectorOptions,
  type BranchContextRebuildOptions,
} from "./branch-context-projector.js";
export {
  CaptureWorker,
  InvalidCaptureWorkerConfigurationError,
  terminalQueueState,
  type CaptureWorkerOptions,
  type CaptureWorkerQueue,
  type CaptureWorkerRunResult,
  type CaptureWorkerStore,
} from "./capture-worker.js";
export {
  CorrectionCaptureProjector,
  type CorrectionCaptureProjectionResult,
  type CorrectionCaptureProjectionStore,
  type CorrectionCaptureProjectorOptions,
  type CorrectionCaptureRebuildOptions,
} from "./correction-capture-projector.js";
export {
  DeletionPropagationGateError,
  DeletionService,
  type DeletionExecutionResult,
  type DeletionKnowledgeProjection,
  type DeletionQueue,
  type DeletionServiceOptions,
  type DeletionStore,
} from "./deletion-service.js";
export {
  KnowledgeLifecycleProjector,
  type KnowledgeLifecycleProjectionResult,
  type KnowledgeLifecycleProjectionStore,
  type KnowledgeLifecycleProjectorOptions,
  type KnowledgeLifecycleRebuildOptions,
} from "./knowledge-lifecycle-projector.js";
export {
  KnowledgeControlService,
  type KnowledgeControlProjection,
  type KnowledgeControlResult,
  type KnowledgeControlServiceOptions,
  type KnowledgeControlStore,
  type RememberKnowledgeInput,
} from "./knowledge-control-service.js";
export {
  CAPTURE_WORKER_PRESSURE_REASONS,
  CaptureWorkerCircuitBreaker,
  InvalidWorkerPressureThresholdError,
  type CaptureWorkerAdmission,
  type CaptureWorkerPressureReason,
  type CaptureWorkerPressureSnapshot,
  type CaptureWorkerPressureThresholds,
} from "./worker-circuit-breaker.js";
export {
  WorkEpisodeProjector,
  type WorkEpisodeProjectionResult,
  type WorkEpisodeProjectionStore,
  type WorkEpisodeProjectorOptions,
  type WorkEpisodeRebuildOptions,
} from "./work-episode-projector.js";

export * from "./learning-coordinator.js";
export * from "./discovery-enrichment.js";
export * from "./capture-retention.js";
