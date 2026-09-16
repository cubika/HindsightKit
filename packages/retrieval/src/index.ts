export {
  KnowledgeProjectionManager,
  knowledgeProjectionFromCandidate,
} from "./projection.js";
export {
  CanonicalKnowledgeRetriever,
} from "./retriever.js";
export {
  ContextRetrievalService,
  DEFAULT_CONTEXT_TIMEOUT_MS,
  MAX_CONTEXT_TOKENS,
  MAX_SEARCH_TOKENS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  estimateRenderedTokens,
  type ContextRetrievalServiceOptions,
} from "./context-service.js";
export {
  SqliteFtsKnowledgeBackend,
  type SqliteFtsKnowledgeBackendOptions,
} from "./sqlite-fts-knowledge-backend.js";
export {
  AUTOMATIC_RETRIEVAL_EVIDENCE_TIERS,
  branchScopeIdFor,
  scopeMatches,
  type CanonicalKnowledgeAdmissionStore,
  type CanonicalKnowledgeStore,
  type CanonicalContextStore,
  type ContextExplanation,
  type ContextFeedbackAction,
  type ContextFeedbackRequest,
  type ContextFeedbackResponse,
  type ContextItem,
  type ContextItemKind,
  type ContextRequest,
  type ContextSearchRequest,
  type ContextResponse,
  type KnowledgeBackend,
  type KnowledgeBackendHealth,
  type KnowledgeAdmissionEvidence,
  type KnowledgeProjection,
  type KnowledgeProjectionSnapshot,
  type KnowledgeQuery,
  type KnowledgeRecord,
  type KnowledgeRetrievalQuery,
  type RetrievedKnowledge,
  type ReferenceContextMetadata,
} from "./types.js";
