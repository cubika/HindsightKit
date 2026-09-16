import { mkdir, open, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createSyntheticExperienceRetrievalCorpus, experienceRetrievalCorpusSchema, runLocalExperienceRetrievalEvaluation } from "../packages/evaluation/dist/index.js";

const args = process.argv.slice(2);
try {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!["--corpus", "--out"].includes(key) || !value || value.startsWith("--") || options.has(key)) {
      throw new Error("Use node scripts/evaluate-experience-retrieval.mjs [--corpus LOCAL_JSON_FILE] [--out DIRECTORY] after building.");
    }
    options.set(key, value);
  }
  let corpus = createSyntheticExperienceRetrievalCorpus();
  if (options.has("--corpus")) {
    const file = await open(resolve(options.get("--corpus")), "r");
    try {
      if ((await file.stat()).size > 16 * 1024 * 1024) throw new Error("Local corpus exceeds 16 MiB.");
      corpus = experienceRetrievalCorpusSchema.parse(JSON.parse(await file.readFile("utf8")));
    } finally { await file.close(); }
  }
  const directory = resolve(options.get("--out") ?? join(".provenloop", "experience-retrieval-evaluation", new Date().toISOString().replace(/[:.]/gu, "-")));
  const report = await runLocalExperienceRetrievalEvaluation(corpus);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "corpus.json"), JSON.stringify(corpus, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ directory, sourceKind: report.sourceKind, corpusDigest: report.corpusDigest,
    current: report.current.metrics, lexicalBaseline: report.lexicalBaseline.metrics, limitations: report.limitations }, null, 2));
  if (report.current.metrics.failedQueries || report.lexicalBaseline.metrics.failedQueries) process.exitCode = 1;
} catch {
  console.error("Local retrieval evaluation failed. Check arguments, corpus schema, build output, and output-directory collisions. No source content was sent to a service.");
  process.exitCode = 1;
}
