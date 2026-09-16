# First scalability repair evidence

These results measure local changes based on commit
798afd7f881f6763d31ef0d035a50f63c185c532. See the
[implementation record](../../../scalability-review.md#9-first-implementation-pass)
for behavior changes and unresolved work.

| File | Scope |
|---|---|
| [results.json](results.json) | Repeated all-mode session curve and FTS growth probes |
| [event-results.json](event-results.json) | Fixed-session event growth and narrowed evidence reads |
| [quality-results.json](quality-results.json) | Exclusion refill, per-response duplication and weak-word matching |
| [lock-results.json](lock-results.json) | Successful schema-21 open during another write transaction |
| [additional-results.json](additional-results.json) | Sparse/connected comparison and a real changed-content index operation |
| [validation.json](validation.json) | Commands, final checks and source/evidence hashes |

The single-record timings in results.json resubmit unchanged content. The
changed-content measurement is separate. Connected mode preserves grouping but
omits weak association suggestions; the original all-mode output has a larger
association set. Memory values are process RSS samples, and database sizes
exclude WAL/SHM. Hardware was not recorded. These runs do not establish an
installed-host deadline or sustained supported capacity.

The original baseline files in the parent directory remain unchanged. No user
database or captured session is included here. The reproduction script's
PROVENLOOP_SCALE_ASSOCIATION_MODE option selects all, sparse or connected;
omission preserves the baseline all behavior.
