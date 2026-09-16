import { resolve, join } from "node:path";
import { prepareFrozenLearningEvaluation, createGeneralLearningCorpus, createAgentExperienceCorpus, runFrozenLearningEvaluation, reviewFrozenLearningEvaluation,
  exportInstalledLearningCorpus, importInstalledLearningAcceptance, resolveLearningEvaluationCodeVersion,
  resolveLearningEvaluationExecutableDigest } from "../packages/evaluation/dist/index.js";
import { CopilotLearningProvider, readCopilotAdapterState, resolveAutomaticLearning } from "../packages/copilot-adapter/dist/index.js";
import { resolveWindowsProvenLoopPaths, resolveWindowsProvenLoopLeaseName, WindowsNamedPipeLeaseProvider } from "../packages/platform-windows/dist/index.js";
import { CanonicalSqliteStore } from "../packages/storage-sqlite/dist/index.js";

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const required = (name) => { const value = option(name); if (!value || value.startsWith("--")) throw new Error("Missing " + name); return value; };
const executableDigest = () => resolveLearningEvaluationExecutableDigest(process.cwd());
const codeVersion = () => resolveLearningEvaluationCodeVersion(process.cwd());
const allowed = new Set(["--out", "--prepared", "--data-root", "--max-requests", "--max-attempts", "--labels-a", "--labels-b",
  "--run", "--review-a", "--review-b", "--maximum-windows", "--evidence", "--manifest", "--artifact-root", "--corpus"]);
try {
  const command = args[0];
  for (let index = 1; index < args.length; index += 2) if (!allowed.has(args[index]) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("Unknown option or missing value.");
  let result;
  if (command === "prepare") {
    const corpus = option("--corpus") ?? "default";
    if (!["default", "general", "agent"].includes(corpus)) throw new Error("Unknown corpus; use default, general or agent.");
    result = await prepareFrozenLearningEvaluation({ outputDirectory: resolve(required("--out")),
      ...(corpus === "general" ? { corpus: createGeneralLearningCorpus() } : corpus === "agent" ? { corpus: createAgentExperienceCorpus() } : {}) });
  }
  else if (command === "capture") {
    const paths = resolveWindowsProvenLoopPaths(resolve(required("--data-root")));
    result = await exportInstalledLearningCorpus({ databasePath: paths.database, outputDirectory: resolve(required("--out")),
      maximumWindows: Number(option("--maximum-windows") ?? 40) });
  } else if (command === "run") {
    const paths = resolveWindowsProvenLoopPaths(resolve(required("--data-root")));
    const enabled = async () => { const state = await readCopilotAdapterState(paths.adapterState, new Date());
      return resolveAutomaticLearning(state).enabled; };
    if (!await enabled()) throw new Error("Actual provider evaluation requires enabled automatic learning and its prerequisites in the selected data root.");
    const before = await executableDigest(); const version = await codeVersion();
    const outputDirectory = resolve(required("--out"));
    const labels = [option("--labels-a"), option("--labels-b")].filter((value) => value !== undefined);
    const lease = await new WindowsNamedPipeLeaseProvider(await resolveWindowsProvenLoopLeaseName(paths.root, "learning-inference")).tryAcquire();
    if (!lease) throw new Error("Automatic learning inference is busy in this data root.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGTERM", abort); process.once("SIGINT", abort);
    const store = new CanonicalSqliteStore(paths.database);
    const provider = new CopilotLearningProvider({ temporaryRoot: join(paths.root, "temp"), enabled });
    const currentCode = async () => before === await executableDigest() && version === await codeVersion();
    try { result = await runFrozenLearningEvaluation({ preparedDirectory: resolve(required("--prepared")), outputDirectory,
      provider: { identity: provider.identity, timeoutMs: provider.timeoutMs, infer: async (window, options) => {
        if (!await currentCode()) { controller.abort(); throw new Error("Evaluation code changed before provider dispatch."); }
        return provider.infer(window, options);
      } },
      providerMode: "actual_copilot", codeVersion: version, executableDigest: before,
      signal: controller.signal, reserveAttempt: async () => {
        if (!await currentCode()) { controller.abort(); return false; }
        return await enabled() && store.reserveLearningAttempt(new Date(), 200);
      },
      inputLabelPaths: labels, maxRequests: Number(option("--max-requests") ?? 40), maxAttempts: Number(option("--max-attempts") ?? 1) }); }
    finally { store.close(); process.removeListener("SIGTERM", abort); process.removeListener("SIGINT", abort); await lease.release(); }
    if (before !== await executableDigest() || version !== await codeVersion()) throw new Error("Code changed during evaluation; retain attempts but discard aggregate acceptance.");
    result = { status: "insufficient_evidence", attemptedRequests: result.attempts.reduce((sum, entry) => sum + 1 + (entry.reviewRequests ?? 0), 0), pendingWindows: result.pendingCaseIds.length,
      failedAttempts: result.attempts.filter((item) => !["extracted", "no_rule"].includes(item.status)).length, outputDirectory };
  } else if (command === "review") result = await reviewFrozenLearningEvaluation({ runDirectory: resolve(required("--run")),
    outputReviewPaths: [required("--review-a"), required("--review-b")], outputPath: resolve(required("--out")) });
  else if (command === "import-installed") result = await importInstalledLearningAcceptance({ evidencePath: required("--evidence"),
    artifactManifestPath: required("--manifest"), artifactRoot: required("--artifact-root"), expectedCodeVersion: await codeVersion(),
    expectedExecutableDigest: await executableDigest(), outputPath: resolve(required("--out")) });
  else throw new Error("Use prepare --out DIR [--corpus default|general|agent]; capture --data-root DIR --out DIR; run --prepared DIR --out DIR --data-root DIR [--max-requests 40] [--max-attempts 1] [--labels-a FILE --labels-b FILE]; review --run DIR --review-a FILE --review-b FILE --out FILE; import-installed --evidence FILE --manifest FILE --artifact-root DIR --out FILE.");
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Evaluation failed."); process.exitCode = 1;
}
