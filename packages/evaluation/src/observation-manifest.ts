import { open } from "node:fs/promises";

import { z } from "zod";

import { containsKnownSecret } from "./secret-detection.js";

export const SYNTHETIC_REGRESSION_LIMITATION =
  "Synthetic regression results are not observed user benefits or controlled field effects.";

const version = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const observationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  evidenceKind: z.literal("observational"),
  controlledEffect: z.literal("not_established"),
  codeVersion: version,
  observations: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    sessionDigest: digest.nullable(),
    repoDigest: digest.nullable(),
    codeVersion: version.nullable(),
    invocationCount: count.nullable(),
    providedCount: count,
    explicitlyAdoptedCount: count,
    noMatchCount: count,
    feedbackCount: count,
    unknownStatusRecordCount: count,
    retrievalState: z.enum(["not_observed", "not_invoked", "disabled", "no_match", "provided", "explicitly_adopted", "unknown"]),
    observedCorrectionCount: count,
    subsequentCorrectionCount: count.nullable(),
    verificationSucceededCount: count.nullable(),
    verificationFailedCount: count.nullable(),
    outcome: z.literal("unknown"),
    coverage: z.enum(["bounded_sample", "observed_records"]),
  }).strict().refine((observation) =>
    observation.explicitlyAdoptedCount <= observation.providedCount &&
    (observation.invocationCount === null ||
      observation.providedCount + observation.noMatchCount <= observation.invocationCount),
  "Observation counters are inconsistent.")).max(5_000),
}).strict();

export type ObservationManifest = z.infer<typeof observationManifestSchema>;

export class ObservationManifestInputError extends Error {
  public override readonly name = "ObservationManifestInputError";
}

export const loadObservationManifest = async (
  path: string | undefined,
  codeVersion: string,
): Promise<ObservationManifest | undefined> => {
  if (path === undefined) {
    return undefined;
  }
  try {
    const file = await open(path, "r");
    let text: string;
    try {
      if ((await file.stat()).size > 4 * 1024 * 1024) {
        throw new Error("oversized");
      }
      text = await file.readFile("utf8");
    } finally {
      await file.close();
    }
    const manifest = observationManifestSchema.parse(JSON.parse(text.replace(/^\uFEFF/u, "")));
    if (
      containsKnownSecret(JSON.stringify(manifest)) ||
      manifest.codeVersion !== codeVersion ||
      manifest.observations.some((item) => item.codeVersion !== null && item.codeVersion !== codeVersion)
    ) {
      throw new Error("binding");
    }
    return manifest;
  } catch {
    throw new ObservationManifestInputError("Observation manifest is invalid, unsafe, or bound to a different code version.");
  }
};
