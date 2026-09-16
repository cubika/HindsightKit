# ADR 0004: Extend Mem0 OSS for layered experience learning

Status: accepted direction; implementation and comparative validation pending.
Date: 2026-09-12.
Repository baseline: `622ce109a2028f902e4961b6fabfe6b150cf3a27`, preview 0.16, schema 23.

## Decision

Use Mem0 OSS as the intended foundation for generic memory operations. Extend it
through a ProvenLoop adapter and learning layer. Keep TypeScript and reuse the
existing Copilot capture, background scheduling, and context integration.
Shared types across plugin, worker, MCP, and CLI still support iteration. The
reviewed scale problems call for algorithm and index changes; they do not
establish a need to rewrite the product in another language.

The priorities are experience distillation, accurate retrieval, and useful
consolidation as history grows. Mem0 is selected for its configurable providers,
metadata support, database adapters, and available evaluation tooling. This is
an implementation and maintenance choice, not a demonstrated quality win over
Memorix.

Use public interfaces first. Introduce a narrow upstream extension or maintained
patch only where structured extraction or retrieval requires one. Delete the
custom modules that the integration successfully replaces. Avoid maintaining
two complete generic memory engines indefinitely.

The current product still uses its own learning pipeline and SQLite retrieval.
This document records the agreed direction; it does not announce a migration,
a new installer, or validated Mem0 performance.

## What the product should learn

The product should turn work into experience that helps with later tasks. It
must preserve facts, identify relationships, explain mechanisms, and form
transferable guidance. Later corrections, exceptions, and outcomes must be able
to revise that guidance. More stored records alone do not establish improvement.
Model weights do not change in this design.

The following examples describe intended record types, not measured outputs
from Mem0, Memorix, or ProvenLoop.

| Level | Name | Core question | Example |
|---|---|---|---|
| L1 | Factual experience | What happened? | This API request timed out. |
| L2 | Associative experience | What varies together? | Timeouts were more frequent in the observed runs with larger datasets. |
| L3 | Causal experience | Why did it happen? | The measured query used a full scan; scanning more data increased its execution time. |
| L4 | Pattern or regularity | Under which recurring conditions does this happen? | When partition pruning is unavailable and scanned data or fanout grows, cross-partition queries can develop high tail latency. Measure the growth relationship. |
| L5 | Principle or model | What can guide decisions in other settings? | Align frequent access patterns with partitioning where practical, while accounting for load balance, hotspots, and write costs. |

Cross-partition access does not inherently imply nonlinear latency growth. An
abstraction must preserve its conditions, exceptions, and evidence limits.
Replacing a specific API name with all APIs is not sufficient abstraction.

Level and evidential support are independent. A directly observed L1 may be
reliable while an L5 remains a hypothesis. An explicitly supplied principle can
enter as L5 with its actual attribution; it need not pass through invented
lower-level evidence. Higher levels receive no automatic trust or ranking bonus.

The learning process should capture facts with their source and environment,
compare relevant cases, and retain competing explanations. It should propose
mechanisms and abstractions, look for counterexamples, and link each derived
claim to specific source revisions. Execution success alone does not prove a
causal explanation. Later use must test both applicability and benefit.

Neither reviewed product establishes a complete, validated L1-to-L5 learning
system. This layer is required product work even when generic memory is reused.

## Why Mem0 rather than Memorix

The review used Mem0 commit
[`c7ee362`](https://github.com/mem0ai/mem0/commit/c7ee362aff94a369af70f13f2b4f853f6793ff4c)
and Memorix 1.9.2 commit
[`68e4c318`](https://github.com/AVIDS2/memorix/commit/68e4c318f66514b4950812c3bd490c9dd87d884f).
These findings describe those revisions, not all future releases.

| Concern | Mem0 OSS | Memorix |
|---|---|---|
| Distillation | Single-pass extraction emphasizes concrete facts. Instructions and model providers are configurable. Default extraction does not establish higher-order causal learning. | The full product has engineering-oriented extraction, resolution, and value assessment. Its lightweight SDK store does not execute the complete formation pipeline. |
| Retrieval | Semantic candidates receive keyword/entity boosts and optional reranking. The reviewed route does not add independent keyword-only candidates. | Persistent FTS5 and optional LanceDB supply separate candidates for fusion. This helps exact engineering identifiers; comparative semantic precision is unmeasured. |
| Accumulated history | Automatic extraction is ADD-only, with bounded related-memory context and duplicate checks. Explicit update/delete exist; full automatic consolidation must be supplied. | Merge/evolve and maintenance functions exist. Reviewed paths use short candidate excerpts, text unions, and bounded batches, which can miss exceptions or retain obsolete facts. |
| Scale | Dedicated vector backends offer expansion options. The default TypeScript local vector provider scans records and is not the intended large-store configuration. | Persistent local indexes and batched maintenance have documented growth checks. Some management and candidate-filtering paths still require long-history testing. |
| Integration | Metadata and provider configuration fit a custom memory engine, with adaptation needed for per-memory extraction fields and indexes. | More complete local coding-agent product, including Copilot integration, but public SDK fields and filters are relatively fixed. |

Memorix remains a useful comparison and reuse option. Its plugin, UI, and local
deployment features are less decisive when the main requirement is custom
experience learning. Its existing consolidation should not be treated as a
finished solution: the inspected merge/evolve path also appears to create a new
observation when the chosen target has no `topicKey`, while reporting an update.
This is a [static source finding](https://github.com/AVIDS2/memorix/blob/68e4c318f66514b4950812c3bd490c9dd87d884f/src/server.ts#L923),
not a runtime reproduction. Its
[resolution logic](https://github.com/AVIDS2/memorix/blob/68e4c318f66514b4950812c3bd490c9dd87d884f/src/memory/formation/resolve.ts)
can retain old facts alongside new facts.

Mem0 Platform is separate from OSS. Its hosted
[Dream service](https://docs.mem0.ai/platform/features/dream) provides automatic
Merge and Supersede, plus optional scheduled Synthesis. Synthesis has plan and
scope restrictions, including requiring user-only memories. These capabilities
are not included in the selected OSS engine.

### Public evidence and its limits

- The [Mem0 evaluation repository](https://github.com/mem0ai/memory-benchmarks#results)
  reports OSS LongMemEval accuracy of 91.0% with GPT-5 extraction, Qwen 600M
  embeddings, Qdrant, and GPT-5 answering and judging. This is a combined
  question-answering result, not extraction accuracy or Precision@3.
- The same repository reports Platform LongMemEval at 94.4% with up to 200
  retrieved memories. Its BEAM 10M-token result has a 50.5% pass rate. Tokens
  describe conversation length, not stored record count.
- [Memorix's performance notes](https://github.com/AVIDS2/memorix/blob/68e4c318f66514b4950812c3bd490c9dd87d884f/docs/PERFORMANCE.md)
  report a 100,000-record Windows/Node 22 check with about 419 MB peak RSS and
  296 ms cold HTTP MCP search. Embeddings were disabled; this is not a semantic
  quality result or a universal latency guarantee.

No shared dataset, model configuration, hardware, or context allowance was used
to compare these products in this discussion. No comparative benchmark was
executed. Neither a maximum safe collection size nor a quality winner is known.

## What to reuse and what to extend

| Responsibility | Intended owner |
|---|---|
| Copilot events, trusted workspace identity, durable queue, and context delivery | Existing ProvenLoop host integration |
| Generic extraction orchestration, provider adapters, embedding integration, and memory CRUD | Mem0 OSS through an application-owned adapter |
| Vector index storage and search | An established database; local Qdrant is the first candidate to validate |
| Independent lexical retrieval, rank fusion, and optional reranking | Established search components composed by the adapter |
| L1-L5 classification, derivation, causal support, counterexamples, and controlled consolidation | ProvenLoop learning layer |
| Source mapping, explicit user controls, and execution-verification receipts | ProvenLoop policy and evidence layer |

Define an application-owned `MemoryEngine` boundary for structured writes,
search, update, deletion, and maintenance. The existing `KnowledgeBackend`
projection and retrieval boundary does not cover extraction or authoritative
memory lifecycle.
Contracts describe required behavior; they do not require retaining every
existing class, table, prompt, or second model review.

Use one authority for generic memory state. Preserve source events and
verification records separately where necessary. Indexes are rebuildable, and
their revisions must agree with the current record before delivery.

### Structured fields and search

Every experience needs its own content, conditions, exceptions, classification,
sources, and revision. Add `level`, revision-bound `derivedFrom`, and
support/contradiction relationships. Keep evidence status separate from level
and model confidence. The detailed
[structured-field proposal](../structured-memory-fields.md) owns field mappings
and query behavior.

The reviewed Mem0 extractor persists selected output fields and call-level
metadata. Extra prompt output does not automatically become per-memory
metadata. Extend parsing and payload mapping together, and validate each item.
External extraction followed by `infer: false` is a fallback that skips Mem0's
default extraction and associated deduplication; account for that lost reuse.

Full-text and semantic discovery should include relevant content, conditions,
topics, entities, and approved paraphrases. IDs, level, scope, evidence status,
and timestamps need indexed exact/range filters before candidate limits. Keep
exception-field investigation separate from positive task recommendations.

Union lexical and semantic candidates, fuse ranks, optionally rerank a bounded
shortlist, and recheck scope, revision, and applicability. Investigating a
failure may favor L1/L3; designing a system may favor L4/L5 with expandable
supporting cases. Level alone does not determine relevance.

### Growth, merging, and correction

Run consolidation incrementally over changed records and relevant neighbors.
Track resumable work, index revisions, and maintenance lag. A fixed
head-of-collection batch is insufficient for long-term coverage.

Distinguish exact duplicates, complementary information, contradictions, and
generalizations. Merging must preserve conditions, exceptions, and precise
source relationships. A change to one clause cannot silently validate the whole
new record. Revisit derived claims when their supporting evidence changes.

Retain revision history and user controls while keeping obsolete records out of
ordinary current-guidance retrieval. Historical investigation can request them
explicitly. Define retention, archival, and capacity policies for raw evidence
and derived memory separately. Do not treat deletion of difficult cases as a
quality improvement or impose an arbitrary corpus cap to hide scaling defects.

## Local operation, accounts, and installation

Mem0 OSS and local database software do not require a Mem0 cloud account. Use a
local embedding model and adapt the signed-in Copilot CLI/SDK for extraction.
The reviewed Mem0 TypeScript LangChain provider offers a possible adapter path;
structured responses, deadlines, errors, and cancellation still need tests.
There is no built-in Copilot provider in the reviewed revision.

Copilot [supports its existing CLI sign-in through the SDK](https://github.com/github/copilot-sdk#faq).
Background extraction consumes the user's applicable Copilot allowance. Local
storage does not mean offline processing: excerpts used for extraction still
go to Copilot. A fully offline option also needs a local extraction model.

Qdrant is a backend option, not a Mem0 requirement. If selected in server mode,
it adds a local service. An installer can eventually provision the pinned
runtime, database, embedding model, persistent paths, and startup management,
then check write/search/restart behavior. Packaging remains open; Docker/WSL
may require administrator interaction or a restart. The current ProvenLoop
installer has not implemented this setup.

### Existing coding-agent plugins

Mem0's reviewed native Claude/Codex plugins already implement local capture,
durable background submission, and automatic first-prompt recall. Their
[shared core](https://github.com/mem0ai/mem0/tree/c7ee362aff94a369af70f13f2b4f853f6793ff4c/integrations/agent-plugin-core)
sends extraction and retrieval requests to Mem0 Platform. The checked catalog
has no native Copilot plugin; a portable MCP/skills package does not supply
native capture hooks. Some other host integrations offer OSS mode.

Memorix has a native Copilot plugin, but its background memory model has separate
provider configuration. Copilot plugin support does not automatically mean
reuse of the user's Copilot login for extraction.

These products overlap with ProvenLoop's basic capture and recall experience.
Retain the existing Copilot capture path for the selected integration and reuse
Mem0 beneath it. Organize extraction inputs around related work and sources; a
fixed number of exchanges is a scheduling boundary, not evidence that a problem
has been resolved. Bound queued work and retention, and sanitize before initial
persistence as well as before remote inference.

## Delivery and acceptance

First implement an isolated vertical slice:

1. Capture an interaction through the existing host and preserve its sources.
2. Extract structured experiences through Mem0 with the Copilot adapter.
3. Store and retrieve locally, including a match found only in an extra field.
4. Add repetition, a correction, and an exception; consolidate without losing
   their meaning or sources.
5. Query from a later task, inspect the explanation, then test withdrawal and restart.

Compare the complete engine against the current implementation and a pinned
Memorix configuration using the same inputs. Hold the extraction model,
embedding model, hardware, query labels, and output token budget constant where
possible. Record unavoidable differences rather than hiding them in one score.

Use held-out cases and chronological growth tests. Proposed tiers are 1,000,
10,000, 100,000, and 1,000,000 records; these are test sizes, not promised
capacities. Vary raw-event and derived-memory growth separately, including
concurrent writes, irrelevant neighbors, duplicates, and obsolete revisions.

Measure:

- extraction coverage, unsupported claims, and preservation of conditions;
- correctness of each level's derivation, including counterexamples and transfer;
- Precision@3, Recall@3, correct abstention, wrong-scope/stale results, and field filters;
- merge correctness, duplicate reduction, lost exceptions, and correction propagation;
- cold/warm search p50/p95, memory, index size, write-to-search delay, and maintenance lag;
- model cost, later-task benefit, and the amount of custom code actually retired.

Acceptance requires preserved user controls and source semantics, measured
quality and cost within the chosen operating budget, and demonstrated removal
of duplicate implementation. If the necessary patches become broad or the
results do not improve, revisit the engine choice before expanding migration.

## Related decisions and evidence

- [Current architecture](../architecture.md): existing runtime and boundaries.
- [Experience retrieval](../experience-retrieval-design.md): implemented discovery behavior.
- [Scalability review](../scalability-review.md): historical-processing findings and remediation.
- [Mem0 OSS migration guide](https://docs.mem0.ai/migration/oss-v2-to-v3): ADD-only extraction and candidate-scoring boundaries.
- [Mem0 extraction prompts](https://github.com/mem0ai/mem0/blob/c7ee362aff94a369af70f13f2b4f853f6793ff4c/mem0/configs/prompts.py): default factual-extraction intent.
- [Memorix SDK](https://github.com/AVIDS2/memorix/blob/68e4c318f66514b4950812c3bd490c9dd87d884f/src/sdk.ts): supported fields and programmatic write path.

This ADR supersedes the earlier tentative preference for Memorix as the primary
reuse candidate. It does not alter the shipped backend or claim that either
product already delivers reliable five-level learning.
