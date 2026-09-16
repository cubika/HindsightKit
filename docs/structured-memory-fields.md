# Structured memory fields and search

Status: proposed field and retrieval contract. Mem0 integration is not implemented.
Date: 2026-09-12.

The accepted [Mem0 and layered-learning decision](decisions/0004-mem0-layered-learning.md)
sets the implementation direction. This document specifies proposed fields and
query behavior; the runtime has not migrated.

The requested memory record includes a readable conclusion and additional fields
that can be searched. Each field has a defined retrieval role: text relevance,
exact filtering, or applicability checks. Merely storing a value in Mem0 metadata
does not make it part of semantic retrieval.

## Record contract

Use a versioned application record. Mem0's `memory` maps to the current
`KnowledgeCandidate.content`; existing fields keep their meanings during
migration. Additional fields belong to each individual memory, even when several
memories are extracted from one conversation.

| Field | Meaning and producer | Retrieval behavior |
|---|---|---|
| `memory` | Conclusion, including its essential conditions; extractor proposes it | Full-text and semantic relevance |
| `level` | Factual (L1), associative (L2), causal (L3), pattern (L4), or principle/model (L5); separate from evidence status | Exact filter and task-dependent selection; no automatic trust or ranking bonus |
| `derivedFrom` | Host-validated links to specific revisions of experiences used in a derivation | Exact relationship lookup and explanation expansion |
| `supportingEvidence`, `counterEvidence` | Links to evidence supporting or challenging the claim | Source lookup, claim review, and invalidation when dependencies change |
| `appliesWhen` | Conditions under which the conclusion helps; extractor proposes them | Full-text and semantic relevance, followed by applicability checks |
| `nonApplicability` | Exceptions or excluded contexts; extractor proposes them | Applicability checks; explicit field search during investigation |
| `kind` | Existing episodic / semantic / procedural classification | Exact filter |
| `retentionKind` | Existing convention / reference / recovery classification, when present | Exact filter, separate from `kind` |
| `purposes` | Fact, constraint, lesson, procedure, or rationale | Exact filter |
| `topics`, `entities`, `paraphrases` | Subject, named identifiers, and equivalent wording with supporting basis and polarity | Positive features contribute lexical/semantic discovery; topic and entity filters support explicit lookup |
| `scope`, `scopeId` | Host-resolved repository, branch, workflow, or personal scope | Mandatory filtering before candidate limits |
| `sourceEvidenceIds`, `sourceEpisodeIds`, `sourceReferences` | Host-validated source bindings and navigation pointers | Exact source lookup; file paths and URLs support explicit literal lookup |
| `state`, `evidenceTier`, `validatedAt` | Lifecycle and verification information set by product policy or explicit user action | Exact filters and delivery checks |
| `createdAt`, `expiresAt` | Recorded creation and expiration times | Time-range filters and expiration checks |
| `schemaVersion`, `recordRevision`, `knowledgeId` | Application-managed identity and revision | Compatibility checks, exact lookup, and stale-index rejection |

The extractor can propose content and classification. The host assigns trusted
identity, source bindings, lifecycle state, and verification status. A model's
confidence is not an execution-verification result.
Level is independent of `kind`, `retentionKind`, and `purposes`. Existing records
without a level remain searchable; they do not receive an invented classification.

The following is an illustrative application record, not the response shape of
an unmodified Mem0 `add()` call. IDs are examples. The topic is a proposed label.
Stored discovery features retain the current basis and polarity information;
the example shows the compact values used for indexing.

```json
{
  "memory": "Use pnpm in this repository. The legacy directory continues to use npm.",
  "metadata": {
    "schemaVersion": 1,
    "recordRevision": 1,
    "knowledgeId": "example-package-manager-rule",
    "kind": "procedural",
    "retentionKind": "convention",
    "purposes": ["constraint"],
    "topics": ["package-management"],
    "entities": [
      {"kind": "tool", "value": "pnpm", "polarity": "positive"},
      {"kind": "path", "value": "legacy/", "polarity": "excluded_context"}
    ],
    "appliesWhen": ["Installing dependencies in this repository"],
    "nonApplicability": ["Operations inside legacy/"],
    "scope": "repository",
    "scopeId": "example-repository",
    "sourceEvidenceIds": ["example-user-event"],
    "state": "candidate",
    "evidenceTier": "inferred",
    "createdAt": "2026-09-12T00:00:00Z"
  }
}
```

## Query behavior

Support natural-language queries and explicit field filters together. The
following proposed application request asks for confirmed constraints about
dependency tooling. ProvenLoop supplies the permitted scope from the host.

```json
{
  "query": "Which tool should install dependencies?",
  "filters": {
    "purposes": ["constraint"],
    "topics": ["package-management"],
    "evidenceTiers": ["user_confirmed"]
  },
  "limit": 3
}
```

Different filter fields combine with AND; values within one field combine with
OR. Missing fields do not satisfy an explicit filter. An empty text query may
browse records using filters and stable pagination, without requesting an
embedding. Pagination must use a consistent record/index revision.
The illustrative inferred record above does not match this confirmed-only
query until an explicit confirmation changes its evidence tier.

For ordinary task recall, apply scope, lifecycle, expiration, and requested
indexed filters before selecting lexical and semantic candidates. Union those
candidates by stable memory identity, fuse their ranks, and rerank a bounded
shortlist. Recheck current state and task applicability before rendering.
Return matching field names and source references so callers can explain a hit.

Store the readable memory unchanged. Build a separate, versioned search
projection from the conclusion, positive conditions, topics, named entities,
and approved paraphrases. Preserve field labels and conditions. Exact code
identifiers, paths, and error codes also need a lexical candidate route.

Exceptions remain available for queries such as "find rules whose exceptions
mention legacy" through an explicit `nonApplicability` field search. That
investigation result does not authorize applying the rule inside the excluded
directory. Exclusion-only entities and phrases never become positive discovery
aliases. Full memory text remains available for inspection and reranking.

Create payload or relational indexes for commonly used filters. Adding filters
after a small global top-k risks missing relevant records in a large collection.
Do not serialize all metadata into one embedding: IDs, timestamps, status, and
negative conditions need their own query semantics.

## Mem0 integration requirements

The reviewed TypeScript implementation is `mem0ai` 3.1.8 at commit
[`d873892`](https://github.com/mem0ai/mem0/commit/d873892dad288744cde5d6d845539616dc0f7993).
Its [extraction-to-payload mapping](https://github.com/mem0ai/mem0/blob/d873892dad288744cde5d6d845539616dc0f7993/mem0-ts/src/oss/src/memory/index.ts#L998)
copies call-level metadata and selected extracted fields. An extraction prompt
alone cannot persist arbitrary per-memory fields.

The preferred integration retains Mem0's generic memory operations and provides
one tested extension point for structured extraction, validation, and per-memory
payload mapping. Check upstream support before maintaining a patch. If the
available API cannot support this reliably, external structured extraction plus
`infer: false` is a fallback; it skips Mem0's default extraction and associated
deduplication, which must be included in the tradeoff. Never assign every memory
in a batch the same extracted trigger, exception, or source set.

The reviewed OSS [search implementation](https://github.com/mem0ai/mem0/blob/d873892dad288744cde5d6d845539616dc0f7993/mem0-ts/src/oss/src/memory/index.ts#L1430)
uses semantic candidates with keyword/entity boosts. The integration must add
independent lexical candidates to support exact field and identifier discovery.
Mem0 scores also require calibration or rank fusion instead of the current
FTS-specific score formula.

One component owns each record's generic memory state. During migration, the
existing [knowledge contract](../packages/contracts/src/knowledge-candidate.ts)
and [discovery contract](../packages/contracts/src/discovery.ts) provide field
mappings. Keeping both complete lifecycle engines indefinitely would defeat
the purpose of adopting Mem0. ProvenLoop still needs trusted source and scope
bindings, user controls, and verification receipts.

Content or searchable-field edits produce a new search revision and refresh the
affected indexes. Status-only edits refresh filter state without re-embedding
unchanged text. Deletes and expired revisions must stop appearing while index
updates are pending; retries must not restore a withdrawn record.

## Acceptance cases

- A query matches a relevant trigger, topic, or entity absent from the conclusion.
- A code identifier outside the semantic candidate set is recovered lexically.
- Kind, purpose, topic, source ID, evidence tier, and date filters work before
  candidate limits, including a selective match behind many unrelated records.
- Explicit exception-field search finds an excluded term; ordinary task recall
  does not recommend that rule in its excluded context.
- Several memories from one input retain their own conditions and source sets.
- Updating a searchable field removes its obsolete terms after publication;
  stale revisions and deleted sources cannot be delivered during the transition.
- Restart preserves fields, indexes, and result integrity. A full index rebuild
  produces equivalent retrieval from the same source records.
- A fixed bilingual engineering query set measures Precision@3, Recall@3,
  correct abstention, field-filter accuracy, and end-to-end latency as the
  collection grows. Passing functional tests is not a capacity or quality claim.

Existing field/discovery regressions were checked on 2026-09-12 with:

```powershell
npm test -- tests/unit/discovery-profile.test.ts tests/unit/remember-discovery.test.ts tests/unit/mcp-search.test.ts tests/unit/discovery-integration-review.test.ts
```

Result: 4 files and 90 tests passed. These exercise the current SQLite/discovery
implementation. They do not validate the proposed Mem0 integration.
