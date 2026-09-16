import { buildLearningWindows, createCaptureEnvelope } from "@provenloop/domain";
import { frozenLearningCorpusSchema, type FrozenLearningCorpus } from "./automatic-learning-corpus.js";

// Authored discovery examples; expected meanings are test design, not independent labels.
export const GENERAL_LEARNING_EXAMPLES = [
  { id: "INT-07", context: "The report was generated successfully using gross revenue.", correction: "This revenue report must use net revenue after refunds. Apply that definition to this report in future.", rule: "Use net revenue after refunds in this report.", near: "Produce an optional gross revenue comparison; keep the existing report definition." },
  { id: "INT-03", context: "The upload client uses the global timeout setting.", correction: "Set the timeout globally. Correction: apply the timeout only to uploads in this client, leaving other requests unchanged.", rule: "Apply the timeout only to uploads in this client.", near: "What would happen if uploads used a different timeout? Do not change the policy." },
  { id: "DAT-01", context: "PATCH customer treated an omitted nickname as an empty string.", correction: "For this PATCH endpoint, an omitted nickname means unchanged and an empty string clears it. Preserve explicit zero values in numeric fields.", rule: "Distinguish omitted and empty nickname values in this PATCH endpoint.", near: "Explain how PATCH and PUT usually handle missing fields; I am asking a question." },
  { id: "DAT-02", context: "Settlement rounded every intermediate amount to two decimal places.", correction: "Round only the final settlement amount using the currency minor unit. Do not round the intermediate calculation.", rule: "Round settlement at the final currency boundary.", near: "Try rounding this example to compare the answer; this is an experiment, not a lasting rule." },
  { id: "DAT-03", context: "The API expects seconds but this client passes milliseconds.", correction: "Convert milliseconds to seconds at this client API boundary; internal durations must stay in milliseconds.", rule: "Convert duration units only at this API boundary.", near: "Convert this one displayed number to seconds for the explanation only." },
  { id: "DAT-04", context: "A daily local-time reminder was implemented by adding 24 hours.", correction: "This reminder follows the local calendar time across daylight saving transitions. Use calendar recurrence here, not elapsed 24-hour intervals.", rule: "Use local calendar recurrence for this reminder.", near: "For this one example show the time 24 hours later; do not change the reminder." },
  { id: "DAT-06", context: "Tied scores reordered between cursor pages.", correction: "For this paginated ranking, break equal scores by the stable record ID and keep that order in the cursor.", rule: "Bind the ranking cursor to score and stable record ID.", near: "Would sorting equal scores by record ID help? Investigate before deciding." },
  { id: "DAT-07", context: "The conversion report averaged group percentages equally.", correction: "This conversion rate uses total conversions divided by total eligible visits. Do not average group percentages equally.", rule: "Compute this rate from the specified total population.", near: "Show an optional unweighted mean next to the existing metric without changing its definition." },
  { id: "DAT-08", context: "Late transactions appeared in the arrival-day revenue report.", correction: "Revenue belongs to the transaction date under this report policy, even when the record arrives later. Keep freshness monitoring arrival-based.", rule: "Use transaction date for revenue reporting.", near: "Summarize late arrivals today for operational monitoring." },
  { id: "API-01", context: "The request returned success before its database write finished.", correction: "This endpoint may report success only after its write commits. Keep the separate background queue asynchronous.", rule: "Await the endpoint write commit before reporting success.", near: "Explain why the background queue returns immediately; no behavior change is requested." },
  { id: "API-02", context: "An older search response replaced a newer query result.", correction: "Only the current request generation may update this search view. Ignore stale responses after a new query.", rule: "Bind search view updates to the current request generation.", near: "Collect every response in this diagnostic trace, including old requests." },
  { id: "API-03", context: "Retry after commit and response timeout created a second order.", correction: "Retries of the same order submission must reuse one idempotency key. Distinct orders need distinct keys.", rule: "Scope order idempotency to one logical submission.", near: "Submit another separate order with these similar fields." },
  { id: "API-05", context: "The first record update committed before the second update failed.", correction: "These two account updates form one atomic transaction. Roll both back if either fails.", rule: "Keep both account updates in the declared transaction.", near: "Describe a compensating workflow as an alternative without changing this transaction." },
  { id: "API-08", context: "The streaming reader retained the file handle after cancellation.", correction: "This stream owns its reader and must close it on cancellation as well as completion. Keep buffering bounded.", rule: "Close the owned streaming reader on cancellation and completion.", near: "Read this tiny fixture fully for this one debugging task." },
  { id: "DEV-03", context: "A generated client edit disappeared when generation ran.", correction: "Change the generator input for this client. Generated files are overwritten; use the documented handwritten extension points for custom code.", rule: "Modify the generator input or supported extension point for this client.", near: "Show a temporary generated-file diff to explain the generator output." },
  { id: "DEV-07", context: "Only parser unit tests ran after a database migration change.", correction: "Schema changes here require a migration check against existing data. Unrelated parser tests do not validate the migration.", rule: "Validate schema changes with an existing-data migration check.", near: "For this parser-only change run the parser unit tests." },
  { id: "ART-01", context: "The repository document was written in the conversation language.", correction: "Repository documents must be English even when we talk in Chinese. Preserve executable identifiers and original quotations.", rule: "Write repository documentation in English while preserving identifiers and quotations.", near: "Translate this one paragraph into Chinese for our conversation only." },
  { id: "ART-04", context: "Copying the spreadsheet formula moved the tax-rate reference.", correction: "The tax-rate input must stay fixed when this formula is copied; transaction-row references should continue moving.", rule: "Keep the tax-rate reference fixed when copying this formula.", near: "Show how relative references move in this small example." },
  { id: "ART-06", context: "The report copied the template sample customer and date.", correction: "Use this template's structure, but populate the customer and date from the current report input every time.", rule: "Separate template structure from current report values.", near: "Explain the sample customer fields in the template without creating a report." },
  { id: "ART-08", context: "An executive summary contained implementation detail.", correction: "Executive summaries for this report should keep decisions and supporting facts concise. Detailed debugging notes still need technical detail.", rule: "Match this report summary detail to its executive audience.", near: "Shorten this one response to fit a message; keep the usual note format." },
] as const;

export const createGeneralLearningCorpus = (): FrozenLearningCorpus => {
  const cases: FrozenLearningCorpus["cases"] = [];
  for (const example of GENERAL_LEARNING_EXAMPLES) {
    for (const variant of ["correction", "negative"] as const) {
      const id = `${example.id}-${variant}`;
      const messages = [example.context, variant === "correction" ? example.correction : example.near, "The turn is complete."];
      const types = ["agent.message", "prompt.submitted", "agent.turn_completed"];
      const events = messages.map((message, index) => createCaptureEnvelope({
        adapter: "copilot-cli", adapterVersion: "1.0.84-1", sourceEventId: `${id}-${index}`,
        sessionId: id, repoId: `repo-${example.id}`, repositoryState: "known_repo", worktree: `C:/fixtures/${example.id}`,
        eventType: types[index] ?? "agent.message", trust: index === 1 ? "user" : "model",
        timestamp: new Date(Date.UTC(2026, 8, 8, 0, 0, index)).toISOString(), content: { message },
      }));
      const window = buildLearningWindows(events, new Date("2026-09-08T00:00:10Z"))[0];
      if (!window) throw new Error(`General learning fixture ${id} did not produce a window.`);
      cases.push({ id, language: "en", scenario: example.id, designStratum: variant, window, contracts: [] });
    }
  }
  return frozenLearningCorpusSchema.parse({ version: 1, corpusId: "general-correction-discovery-v1", sourceKind: "authored_replay", cases,
    tasks: cases.filter((entry) => entry.designStratum === "correction").flatMap((entry) => [
      { id: `${entry.id}-related`, caseId: entry.id, prompt: "Apply the same scoped requirement to another input in this workflow.", designStratum: "related", scope: entry.window.repoId, toolName: "semantic-verifier-unavailable" },
      { id: `${entry.id}-unrelated`, caseId: entry.id, prompt: "Explain the example in another repository without executing its workflow.", designStratum: "unrelated", scope: "other-repo", toolName: "semantic-verifier-unavailable" },
    ]),
  });
};
