# Scalability diagnostic evidence

These synthetic local measurements support the findings in the
[scalability review](../../scalability-review.md). They do not establish a
production capacity limit, release acceptance, or sustained model benefit.

The [first repair results](repair-pass-1/README.md) are stored separately from
this original baseline.

| File | Content |
|---|---|
| [manifest.json](manifest.json) | File hashes, runtime and provenance limits |
| [results.json](results.json) | Session-association and knowledge-index growth probes; historical targeted-test result |
| [event-results.json](event-results.json) | Event growth with fixed session and knowledge counts |
| [quality-results.json](quality-results.json) | Filter starvation, identical-content repetition and weak-word matching |
| [lock-results.json](lock-results.json) | Canonical-store initialization under an existing write transaction |
| [document-validation.json](document-validation.json) | Checks performed when adding the document and reproduction scripts |

The original runs used Node 22.18.0 on Windows and the then-current working tree
with uncommitted changes. They did not record hardware or an immutable source
digest. The source commit in the manifest identifies the later code review,
not the exact build used for these historical measurements. Files above retain
their original bytes; the manifest hashes can detect later edits.

The [scale probe](../../../scripts/scale-review/scale-probe.mjs) and
[event probe](../../../scripts/scale-review/event-probe.mjs) preserve the
fixture logic. Their output location was changed to `evaluation-output` so
rerunning a probe does not overwrite this evidence. Compilation and reproduction
commands are in the main review. No captured user sessions, credentials or
database files are included here.
