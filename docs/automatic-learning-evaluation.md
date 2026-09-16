# Automatic learning evaluation

The workflow freezes source windows before model execution and retains every attempted request. The default corpus contains 40 authored windows: 20 correction scenarios and 20 nearby negative scenarios, evenly split between English and Chinese. It also includes 20 related later-task scenarios and 20 unrelated scenarios. These categories describe the test design. They do not supply independent human labels or measured outcomes.

Run commands from the repository root after building the current source. Use an ignored directory such as `evaluation-output/` for artifacts.

The [general correction-learning test catalog](general-learning-test-catalog.md) defines broader scenario families, paired counterexamples, verification boundaries and preview priorities. Use it when expanding beyond the current parameter-correction corpus; its proposed cases are not executed results.

See the [2026-09-08 validation record](general-learning-validation.md) for executed stage checks, real-provider replay counts, fixes and remaining gaps. Use `prepare --corpus general` to freeze the authored semantic-correction corpus.

## Prepare and label

Agent-origin scenarios follow [EXP-01 through EXP-12](agent-experience-learning.md). Record agent and tool quotations separately from user corrections, and distinguish research candidates from verified recovery. Source-role validation must precede counting extraction or activation.

```powershell
node scripts/evaluate-automatic-learning.mjs prepare --out evaluation-output/frozen-learning-v1
```

This writes `corpus.json`, its SHA-256 manifest, and two blank input-review files. Two human reviewers independently fill in their identity, review time, reusable-rule labels, activation eligibility, expected rule and applicability, and later-task applicability. Review all entries before executing the model. Leave disagreements for adjudication; do not choose labels based on model output. The runner copies completed reviews into the run directory and binds their hashes to the attempt ledger.

The corpus covers missing arguments, varied wording, a multi-step correction, one-time requests, questions, quotations, generic advice, repetition, conflicting conditions, expiry, existing instructions, a synthetic credential-like string, and untrusted instructions in quoted text. Each window has its own source identity. Scenario wording about expiry or duplication does not establish that the runtime enforced those policies; lifecycle regression tests and installed observations supply that evidence.

## Measure extraction

The selected data root must already contain installation state and consent for automatic learning. This command makes actual Copilot requests with the production isolated provider:

```powershell
node scripts/evaluate-automatic-learning.mjs run --prepared evaluation-output/frozen-learning-v1 --out evaluation-output/provider-run-01 --data-root C:/ProvenLoopData --max-requests 40 --max-attempts 1 --labels-a evaluation-output/frozen-learning-v1/input-review-a.json --labels-b evaluation-output/frozen-learning-v1/input-review-b.json
```

For an exploratory machine run, omit both label options. Such a run remains unadjudicated; adding labels afterward cannot turn it into a controlled run. Repeat execution in a new output directory after labels are ready. The default budget is 40 attempted requests and one attempt per window; supported bounds are 200 requests and three attempts. Failures consume budget. Remaining windows are reported as pending.

`attempts.jsonl` is flushed before and after each provider call. A crash may leave an unmatched `attempt_started` entry, which remains evidence of an incomplete attempt. `machine-report.json` records code and executable digests, provider identity, input and output hashes, duration, schema/provenance validation, proposals and typed receipt counts. Provider errors are classified without retaining raw error messages. The review corpus and validated proposals contain bounded source content and must be handled as private review artifacts.

Actual calls over authored windows are labeled `synthetic_provider_replay`. Replaying captured windows is labeled `captured_provider_replay`. Neither mode records native activation, later-task delivery, compliance or visible notices, so those outcomes remain unknown. The runner never invokes a later task by merely reading its prompt.

Two human reviewers then complete the output-review files. Bind each review to the recorded run digest; label semantic correctness and provenance separately from the deterministic receipt result.

```powershell
node scripts/evaluate-automatic-learning.mjs review --run evaluation-output/provider-run-01 --review-a evaluation-output/provider-run-01/output-review-a.json --review-b evaluation-output/provider-run-01/output-review-b.json --out evaluation-output/provider-run-01/adjudication.json
```

The report retains disagreements and missing labels. Discovery recall uses all agreed reusable opportunities, including missed extractions. Precision uses all proposals. A missing or insufficient denominator cannot pass acceptance.

## Review captured installed windows

```powershell
node scripts/evaluate-automatic-learning.mjs capture --data-root C:/ProvenLoopData --maximum-windows 40 --out evaluation-output/captured-review-01
```

This exports eligible redacted canonical windows and their source digests, with blank labels. It refuses an active deletion. Exported files are independent review copies: later source deletion does not erase them. Remove these copies separately when deleting their content. Captured exports include no invented later tasks; attach observed host task evidence through the installed-evidence import.

## Import installed evidence

The installed observer supplies the existing automatic-learning evidence format plus an artifact manifest with `version: 1`, `producer: "provenloop-installed-observer"`, `codeVersion`, `executableDigest`, and `artifacts` entries containing relative `path` and `sha256` fields. Each window, task and observation digest must resolve to a retained artifact under the supplied root. The importer rejects missing files, changed bytes, paths outside that root and mismatched executable versions. A manifest proves file consistency; human review still has to establish observer authenticity and independent annotations. Editing a JSON flag does not provide that evidence.

```powershell
node scripts/evaluate-automatic-learning.mjs import-installed --evidence evaluation-output/installed/evidence.json --manifest evaluation-output/installed/artifacts.json --artifact-root evaluation-output/installed --out evaluation-output/installed/import-report.json
node packages/cli/dist/bin.js eval m2 --out evaluation-output/m2-reviewed --automatic-learning-evidence evaluation-output/installed/import-report.json.evidence.json
```

The importer preserves the supplied installed evidence and writes a separate validation report. It does not promote replay results into installed observations.

The release policy requires at least 20 independently labeled positive discovery opportunities, 20 qualified activation opportunities, 20 applicable later tasks and 20 inapplicable tasks. Thresholds are discovery recall 90%, qualified activation 90%, unprompted delivery 95%, usable-rule precision 95%, and negative abstention 98%. Wrong delivery is measured both per provided item and per task receiving content: both limits are 2% for research and 1% for stable release. Label/provenance completeness and prohibited-activation blocking must be 100%; leakage and fabricated confirmation must be zero. Persistence latency p95 must be at most 120 seconds under the frozen controlled conditions. Provider failures, pauses, unknown outcomes and missing native observations remain visible and prevent a complete acceptance claim.
