# General learning validation, 2026-09-08

This is an exploratory validation pass over the [96-family catalog](general-learning-test-catalog.md). The inventory records stage coverage, not 96 passing end-to-end cases. No installed Copilot host acceptance or controlled productivity result was collected.

## Actual provider experiment

The production isolated Copilot provider executed 40 authored English windows: one correction and one nearby negative for each of 20 semantic families. All 40 requests completed. The 20 correction windows returned 33 untyped proposals; all 20 negative windows returned no proposal. No typed verification receipt was produced. A separate replay of those actual outputs through the current coordinator and in-memory canonical store retained all 33 as candidates, with zero active rules, admitted items, or activation notices.

These are extraction and state observations. There are no independent human labels, so the counts do not establish semantic precision or recall. Later tasks were not executed by a live host. Output review found broader wording than the source in some cases, notably API-01 changing this endpoint to a category of endpoints. Candidate isolation contains that uncertainty; semantic qualification remains unsupported.

The initial four-request smoke run is separate from the 40-window run. The full run used Copilot CLI 1.0.84-1, provider github-copilot, model host-default, and extractor copilot-extractor-v4. The resolved model ID was not exposed. A frozen runner kept the evaluated executable stable while local fixes continued.

- Runner identity: `catalog-snapshot-aa81946dcce1775a`.
- Runner SHA-256: `aa81946dcce1775a51ab70cf75c3d79edf58a8917a1ebb8c1d846b6ea0a742f7`.
- Run interval: 2026-09-08 03:07:13 to 03:17:40 UTC.
- Local artifacts: `.provenloop/general-catalog-validation/full-input/`, `full-run/`, and `recorded-output-runtime-replay.json`. These are ignored review artifacts, not release evidence.

A separate eight-window bilingual check exercised the existing typed path: four English/Chinese correction windows and four question/quotation negatives. Two corrections produced verified argument receipts; two failed output validation. All four negatives returned no rule. Two diagnostic reruns of the failed cases returned valid proposals, but their original failures remain in the record. The original evaluator stored only output digests for these failures, so their exact cause could not be recovered. The evaluator now records a fixed, content-free rejection category for future failures. This typed run remains incomplete evidence, not a passing 8/8 result.

## Fixes from this pass

- General semantic corrections can be proposed without fabricated failed/retry operations. User quotations and supplied operation references are validated; typed activation still requires the full recovery chain. Turn completion can trigger candidate analysis before any technical failure.
- Proof checks reject mismatched actors, operation IDs, command directories, incomplete intermediate events, altered receipts, and sensitive model output. Windows and POSIX path rules are kept distinct.
- Opposite shell substitutions with overlapping applicability become disputed together. Their proofs and conflict links remain available; selecting only one search hit cannot bypass the dispute.
- Host shutdown, temporary disablement and provider unavailability preserve resumable jobs. Retry time and cause are visible; real dispatch still consumes daily budget. Source enrichment refreshes retained proposals without another model call, and delayed native proof can revisit the original turn.
- Expired results cannot commit. Backup restoration cannot silently remove current user controls or reverse protected lifecycle state. SQLite schema 13 prevents older runtimes from reading the new job/proposal format.
- Evaluation requires observed compliance in both supported native/MCP scenarios, preserves label disagreements, rejects count contradictions and revalidates imported artifact bytes at M2 consumption. Report/ledger inconsistencies and missing attempts cannot be hidden by a matching ledger hash.
- Validation failures retain an allowlisted rejection category without raw model output or error text. The two earlier model-validation failures are retained rather than replaced by their successful diagnostic retries.
- Windows atomic replacement retries transient sharing failures with five attempts and 150 ms total backoff. Persistent failure remains an error; failed context writes remain dirty and diagnostic callbacks cannot create unhandled background rejections.

## Reproduce the authored corpus

```powershell
npm run build
node scripts/evaluate-automatic-learning.mjs prepare --corpus general --out .provenloop/general-input
node scripts/evaluate-automatic-learning.mjs run --prepared .provenloop/general-input --out .provenloop/general-run --data-root <consented-data-root> --max-requests 40 --max-attempts 1
```

The ordinary run command still requires automatic-learning consent in the selected profile. This validation used task-authorized synthetic inputs through an isolated provider and did not enable learning on the installed profile. Imported installed evidence now includes a companion `.evidence.json.artifacts.json` binding; preserve it and the referenced artifacts when running M2. Existing bare evidence JSON must be imported again. Applicable task records must identify their scenario as native or mcp.

## Repository verification

- `npm test`: 69 files, 712 tests passed.
- `npm run test:integration`: 25 files, 257 tests passed, including the production build.
- `npm run lint` and `npm run typecheck`: passed.
- `npm run package:verify`: the self-contained tarball installed and passed its runtime checks (961,353 bytes, 24 files).
- `git diff --check`: passed.

An earlier unit run exposed a Windows atomic-replacement failure and an unhandled diagnostic rejection; both received fixes and regressions. An integration run during concurrent source edits failed its frozen-code provenance check; the final run with stable source passed. Model-validation failures from the separate bilingual experiment remain recorded above.

## Per-family inventory

Real provider means an authored correction/negative extraction pair was executed. Regression entries cover only their listed assertions; fixtures and substitute providers do not prove semantic understanding or actual later behavior. Every row still lacks live installed-host observation.

| Family | Exercised level | Assertion or limitation | Evidence |
|---|---|---|---|
| INT-01 | Fixture only | The authored paraphrased-constraint fixture is adjacent to this family. No executed indirect-correction extraction assertion was verified. | [automatic-learning-corpus.ts](../packages/evaluation/src/automatic-learning-corpus.ts) |
| INT-02 | Not exercised | No concrete assertion found for this catalog scenario. Nearby implementation is not counted as coverage. | No selected concrete fixture |
| INT-03 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| INT-04 | Parser only | empty_response_schema | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| INT-05 | Parser only | empty_response_schema | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| INT-06 | Partial regression | typed_qualification, guidance_rendering, applicability, retriever_response | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| INT-07 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| INT-08 | Parser only | empty_response_schema | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| SCP-01 | Partial regression | typed_qualification, guidance_rendering, applicability, retriever_response | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| SCP-02 | Partial regression | scope_admission, contract_identity, retriever_response | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| SCP-03 | Partial regression | native_proof_directory_binding, applicability, retriever_response | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| SCP-04 | Partial regression | native_proof_binding, applicability | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts), [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| SCP-05 | Partial regression | scope_admission, contract_identity, retriever_response | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| SCP-06 | Partial regression | native_proof_binding, applicability | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts), [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| SCP-07 | Partial regression | scope_admission, contract_identity, retriever_response | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| SCP-08 | Partial regression | native_proof_binding, applicability | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts), [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| CAU-01 | Partial regression | typed_qualification_refusal | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| CAU-02 | Partial regression | exact_delta_qualification_refusal | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| CAU-03 | Not exercised | No concrete assertion found for this catalog scenario. Nearby implementation is not counted as coverage. | No selected concrete fixture |
| CAU-04 | Partial regression | session_actor_operation_binding | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts), [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| CAU-05 | Partial regression | window_scheduling, pending_evidence, reevaluation_without_inference | [automatic-learning-proof.test.ts](../tests/unit/automatic-learning-proof.test.ts), [learning-coordinator.test.ts](../tests/unit/learning-coordinator.test.ts) |
| CAU-06 | Partial regression | incomplete_proof_refusal, source_integrity, canonical_enrichment | [automatic-learning-proof.test.ts](../tests/unit/automatic-learning-proof.test.ts), [automatic-learning-proof.test.ts](../tests/unit/automatic-learning-proof.test.ts) |
| CAU-07 | Partial regression | admission_recall_contamination | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| CAU-08 | Partial regression | counterevidence_admission, retriever_response, resolution_ordering | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts), [knowledge-proof-regressions.test.ts](../tests/unit/knowledge-proof-regressions.test.ts) |
| VER-01 | Partial regression | narrow_command_receipt, guidance_rendering | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| VER-02 | Partial regression | narrow_command_receipt, revision_binding | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts), [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| VER-03 | Partial regression | directory_operation_receipt_binding, retriever_response | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts), [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| VER-04 | Partial regression | narrow_command_receipt, guidance_rendering | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| VER-05 | Partial regression | native_completion_refusal | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| VER-06 | Partial regression | trust_source_validation, qualification_refusal | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts), [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| VER-07 | Partial regression | narrow_command_receipt, guidance_rendering | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| VER-08 | Partial regression | typed_qualification_refusal | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| DAT-01 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| DAT-02 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| DAT-03 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| DAT-04 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| DAT-05 | Not exercised | No concrete assertion found for this catalog scenario. Nearby implementation is not counted as coverage. | No selected concrete fixture |
| DAT-06 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| DAT-07 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| DAT-08 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| API-01 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| API-02 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| API-03 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| API-04 | Not exercised | No concrete assertion found for this catalog scenario. Nearby implementation is not counted as coverage. | No selected concrete fixture |
| API-05 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| API-06 | Not exercised | No concrete assertion found for this catalog scenario. Nearby implementation is not counted as coverage. | No selected concrete fixture |
| API-07 | Not exercised | No concrete assertion found for this catalog scenario. Nearby implementation is not counted as coverage. | No selected concrete fixture |
| API-08 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| DEV-01 | Partial regression | native_typed_qualification, canonical_persistence, source_deletion | [shell-learning.test.ts](../tests/unit/shell-learning.test.ts), [shell-learning.test.ts](../tests/unit/shell-learning.test.ts) |
| DEV-02 | Not exercised | No concrete assertion found for this catalog scenario. Nearby implementation is not counted as coverage. | No selected concrete fixture |
| DEV-03 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| DEV-04 | Not exercised | No concrete assertion found for this catalog scenario. Nearby implementation is not counted as coverage. | No selected concrete fixture |
| DEV-05 | Not exercised | No concrete assertion found for this catalog scenario. Nearby implementation is not counted as coverage. | No selected concrete fixture |
| DEV-06 | Not exercised | No concrete assertion found for this catalog scenario. Nearby implementation is not counted as coverage. | No selected concrete fixture |
| DEV-07 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| DEV-08 | Not exercised | No concrete assertion found for this catalog scenario. Nearby implementation is not counted as coverage. | No selected concrete fixture |
| ART-01 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| ART-02 | Not exercised | No concrete assertion found for this catalog scenario. Nearby implementation is not counted as coverage. | No selected concrete fixture |
| ART-03 | Not exercised | No concrete assertion found for this catalog scenario. Nearby implementation is not counted as coverage. | No selected concrete fixture |
| ART-04 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| ART-05 | Not exercised | No concrete assertion found for this catalog scenario. Nearby implementation is not counted as coverage. | No selected concrete fixture |
| ART-06 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| ART-07 | Not exercised | No concrete assertion found for this catalog scenario. Nearby implementation is not counted as coverage. | No selected concrete fixture |
| ART-08 | Real provider + candidate replay | source_representation, candidate_persistence, qualification_isolation, no_activation_notice | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| TRU-01 | Partial regression | consent_state, CLI_control_refusal | [learning-consent.test.ts](../tests/unit/learning-consent.test.ts), [learning-consent.test.ts](../tests/unit/learning-consent.test.ts) |
| TRU-02 | Partial regression | parameter_error_boundary, host_approval_state | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts), [learning-host-approval.test.ts](../tests/unit/learning-host-approval.test.ts) |
| TRU-03 | Partial regression | trust_source_validation, qualification_refusal | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts), [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| TRU-04 | Partial regression | trust_source_validation, qualification_refusal | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts), [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts) |
| TRU-05 | Not exercised | No concrete assertion found for this catalog scenario. Nearby implementation is not counted as coverage. | No selected concrete fixture |
| TRU-06 | Partial regression | sensitive_proposal_refusal, capture_redaction, notice_body_minimization | [general-learning-discovery.test.ts](../tests/unit/general-learning-discovery.test.ts), [capture-envelope.test.ts](../tests/unit/capture-envelope.test.ts) |
| TRU-07 | Partial regression | internal_capture_refusal, window_exclusion, subprocess_environment | [capture-envelope.test.ts](../tests/unit/capture-envelope.test.ts), [incremental-learning.test.ts](../tests/unit/incremental-learning.test.ts) |
| TRU-08 | Partial regression | source_contract_operation_identity, parent_completeness, receipt_integrity | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts), [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| LIF-01 | Partial regression | canonical_deduplication, restart_drain, notice_deduplication | [incremental-learning.test.ts](../tests/unit/incremental-learning.test.ts), [learning-coordinator.test.ts](../tests/unit/learning-coordinator.test.ts) |
| LIF-02 | Legacy-path regression | explicit_correction_aggregation, independent_verification_count | [knowledge-lifecycle-builder.test.ts](../tests/unit/knowledge-lifecycle-builder.test.ts), [knowledge-proof-regressions.test.ts](../tests/unit/knowledge-proof-regressions.test.ts) |
| LIF-03 | Partial regression | independent_typed_receipts, canonical_conflict_state, admission, single_hit_retrieval_suppression, scope_and_command_overlap | [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts), [general-learning-boundaries.test.ts](../tests/unit/general-learning-boundaries.test.ts) |
| LIF-04 | Partial regression | candidate_expiry, reevaluation, non_reactivation | [learning-coordinator.test.ts](../tests/unit/learning-coordinator.test.ts), [learning-coordinator.test.ts](../tests/unit/learning-coordinator.test.ts) |
| LIF-05 | Partial regression | inflight_disable, stale_output_refusal, cleanup | [learning-coordinator.test.ts](../tests/unit/learning-coordinator.test.ts), [learning-provider.test.ts](../tests/unit/learning-provider.test.ts) |
| LIF-06 | Partial regression | deletion_commit_barrier, dependent_rule_deletion, owned_process_cleanup | [learning-coordinator.test.ts](../tests/unit/learning-coordinator.test.ts), [learning-coordinator.test.ts](../tests/unit/learning-coordinator.test.ts) |
| LIF-07 | Partial regression | revocation, resolution_ordering, stale_review_digest | [knowledge-proof-regressions.test.ts](../tests/unit/knowledge-proof-regressions.test.ts), [knowledge-proof-regressions.test.ts](../tests/unit/knowledge-proof-regressions.test.ts) |
| LIF-08 | Partial regression | backup_control_preservation, rebuild_supersession, deletion_tombstones | [canonical-store-reliability.test.ts](../tests/unit/canonical-store-reliability.test.ts), [canonical-store-reliability.test.ts](../tests/unit/canonical-store-reliability.test.ts) |
| SYS-01 | Partial regression | provider_pause_classification, attempt_accounting, foreground_callback_progress | [learning-coordinator.test.ts](../tests/unit/learning-coordinator.test.ts), [learning-provider.test.ts](../tests/unit/learning-provider.test.ts) |
| SYS-02 | Partial regression | bounded_windows, pending_denominators, incremental_scheduling | [shell-learning.test.ts](../tests/unit/shell-learning.test.ts), [incremental-learning.test.ts](../tests/unit/incremental-learning.test.ts) |
| SYS-03 | Local process regression | owner_termination, child_scratch_cleanup, stale_result_refusal | [inference-supervisor.test.ts](../tests/unit/inference-supervisor.test.ts), [learning-coordinator.test.ts](../tests/unit/learning-coordinator.test.ts) |
| SYS-04 | Partial regression | transaction_rollback, retryable_deletion_state | [canonical-store-reliability.test.ts](../tests/unit/canonical-store-reliability.test.ts), [deletion-service-reliability.test.ts](../tests/unit/deletion-service-reliability.test.ts) |
| SYS-05 | Partial regression | job_fairness, lease_lifetime | [incremental-learning.test.ts](../tests/unit/incremental-learning.test.ts), [learning-coordinator.test.ts](../tests/unit/learning-coordinator.test.ts) |
| SYS-06 | Host substitute | runtime_locator, host_version_approval_binding, session_identity | [inference-supervisor.test.ts](../tests/unit/inference-supervisor.test.ts), [learning-host-approval.test.ts](../tests/unit/learning-host-approval.test.ts) |
| SYS-07 | CLI routing only | CLI_routing | [operational-cli.test.ts](../tests/unit/operational-cli.test.ts), [operational-cli.test.ts](../tests/unit/operational-cli.test.ts) |
| SYS-08 | Local process regression | unknown_ownership_refusal, pending_cleanup | [inference-supervisor.test.ts](../tests/unit/inference-supervisor.test.ts), [deletion-service-reliability.test.ts](../tests/unit/deletion-service-reliability.test.ts) |
| UX-01 | Partial regression | literal_instruction_deduplication | [learning-applicability.test.ts](../tests/unit/learning-applicability.test.ts) |
| UX-02 | Not exercised | No concrete assertion found for this catalog scenario. Nearby implementation is not counted as coverage. | No selected concrete fixture |
| UX-03 | Evaluator guard | timing_evidence_gate | [automatic-learning-acceptance.test.ts](../tests/unit/automatic-learning-acceptance.test.ts) |
| UX-04 | Partial regression | notice_retry, notice_mute, stale_notice_refusal | [learning-activation-notice.test.ts](../tests/unit/learning-activation-notice.test.ts), [learning-activation-notice.test.ts](../tests/unit/learning-activation-notice.test.ts) |
| UX-05 | Partial regression | applicability, token_ceiling, scope_and_retrieval_deduplication | [mcp-retrieval.test.ts](../tests/integration/mcp-retrieval.test.ts), [mcp-retrieval.test.ts](../tests/integration/mcp-retrieval.test.ts) |
| UX-06 | Partial regression | label_disagreement, unknown_outcomes, denominator_integrity | [automatic-learning-workflow.test.ts](../tests/unit/automatic-learning-workflow.test.ts), [automatic-learning-acceptance.test.ts](../tests/unit/automatic-learning-acceptance.test.ts) |
| UX-07 | Partial regression | serialization_integrity, artifact_binding, frozen_review_integrity, coverage_integrity | [automatic-learning-workflow.test.ts](../tests/unit/automatic-learning-workflow.test.ts), [automatic-learning-workflow.test.ts](../tests/unit/automatic-learning-workflow.test.ts) |
| UX-08 | Evaluator guard | compliance_benefit_separation, release_gate_no_benefit_claim | [automatic-learning-acceptance.test.ts](../tests/unit/automatic-learning-acceptance.test.ts), [mvp-release-gate.test.ts](../tests/unit/mvp-release-gate.test.ts) |

## Remaining work

The broad semantic families still need independently reviewed meaning and scope, domain-specific verification contracts, and observed later tasks before automatic activation can be added. No result here proves semantic repair from zero tests, cached output, weakened assertions or a mocked success. Indirect ambiguity, multi-stage semantic causality, several document/data workflows, conflicting human authority and task changes within one session still need concrete fixtures. The inventory keeps those gaps visible.
