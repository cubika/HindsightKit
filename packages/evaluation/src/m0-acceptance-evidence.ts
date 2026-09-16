import {
  readFile,
} from "node:fs/promises";

import { z } from "zod";

import {
  PROVENLOOP_VERSION,
} from "@provenloop/contracts";

import {
  containsKnownSecret,
} from "./secret-detection.js";

const safeIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const safeVersionSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u);
const digestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u);
const nonNegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative();
const evidenceStatusSchema = z.enum([
  "fail",
  "pass",
]);
const scenarioStatusSchema = z.enum([
  "fail",
  "pass",
]);

export const m0AcceptanceEvidenceSchema = z
  .object({
    binding: z
      .object({
        captureRunIds: z
          .array(safeIdentifierSchema)
          .min(1)
          .max(30),
        codeVersion: safeVersionSchema,
        copilotCliVersion: safeVersionSchema,
        fixtureVersion: z.literal(1),
        operatingSystemVersions: z
          .array(safeVersionSchema)
          .min(1)
          .max(10),
        pluginVersion: z.literal(PROVENLOOP_VERSION),
        probeVersion: z.literal(1),
        reportDigests: z
          .array(digestSchema)
          .min(1)
          .max(50),
        reportArtifacts: z.array(z.object({
          path: z.string().min(1).max(512),
          sha256: digestSchema,
        }).strict()).max(50).optional(),
        runtimeDigest: digestSchema,
      })
      .strict(),
    capabilityIsolation: z
      .object({
        automatedTestPassed: z.boolean(),
        captureDisabledPassed: z.boolean(),
        correctionLearningDisabledPassed: z.boolean(),
        installedProbePassed: z.boolean(),
        reportDigest: digestSchema,
        retrievalDisabledPassed: z.boolean(),
        status: evidenceStatusSchema,
        workerDisabledPassed: z.boolean(),
      })
      .strict(),
    capture: z
      .object({
        callbackWorkDurationP95Ms: z.number().nonnegative(),
        duplicateCanonicalFactCount: nonNegativeIntegerSchema,
        foregroundAddedLatencyP95Ms: z.number().nonnegative(),
        foregroundBlockingFailureCount: nonNegativeIntegerSchema,
        internalSessionPersistenceCount: nonNegativeIntegerSchema,
        missingRequiredEventCount: nonNegativeIntegerSchema,
        reportDigest: digestSchema,
        seededSecretPersistenceCount: nonNegativeIntegerSchema,
        status: evidenceStatusSchema,
        windows10RepresentativeEventCount: nonNegativeIntegerSchema,
        windows11RepresentativeEventCount: nonNegativeIntegerSchema,
      })
      .strict(),
    doctor: z
      .object({
        onlineClassifications: z
          .array(
            z.enum([
              "available",
              "incompatible",
              "rate_limited",
              "signed_out",
              "unavailable",
            ]),
          )
          .max(10),
        passiveCredentialInspection: z.literal(false),
        passiveModelRequestCount: z.literal(0),
        passiveStatus: z.literal("unverified"),
        reportDigest: digestSchema,
        status: evidenceStatusSchema,
      })
      .strict(),
    evidenceVersion: z.literal(1),
    marketplaceUpgrade: z
      .object({
        disableEnablePassed: z.boolean(),
        fromVersion: safeVersionSchema,
        knowledgeDataPreserved: z.boolean(),
        queueDataPreserved: z.boolean(),
        repeatedInstallPassed: z.boolean(),
        reportDigest: digestSchema,
        settingsRestoredExactly: z.boolean(),
        source: z.literal("cubika/ProvenLoop"),
        status: evidenceStatusSchema,
        toVersion: z.literal(PROVENLOOP_VERSION),
        uninstallPreservedData: z.boolean(),
      })
      .strict(),
    observedGuardrails: z
      .object({
        crossRepositoryLeakageCount: nonNegativeIntegerSchema,
        deletionPropagationFailureCount: nonNegativeIntegerSchema,
        foregroundBlockingFailureCount: nonNegativeIntegerSchema,
        internalSessionPersistenceCount: nonNegativeIntegerSchema,
        secretPersistenceCount: nonNegativeIntegerSchema,
      })
      .strict(),
    providerDegradation: z
      .object({
        backlogDurable: z.boolean(),
        boundedRetry: z.boolean(),
        foregroundUsable: z.boolean(),
        incompatible: scenarioStatusSchema,
        rateLimited: scenarioStatusSchema,
        reportDigest: digestSchema,
        signedOut: scenarioStatusSchema,
        status: evidenceStatusSchema,
        unavailable: scenarioStatusSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (
      new Set(evidence.binding.captureRunIds).size !==
      evidence.binding.captureRunIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Capture run IDs must be unique.",
        path: [
          "binding",
          "captureRunIds",
        ],
      });
    }
    if (
      new Set(evidence.binding.reportDigests).size !==
      evidence.binding.reportDigests.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Report digests must be unique.",
        path: [
          "binding",
          "reportDigests",
        ],
      });
    }
  });

export type M0AcceptanceEvidence = z.infer<
  typeof m0AcceptanceEvidenceSchema
>;

export class M0AcceptanceEvidenceInputError extends Error {
  public override readonly name =
    "M0AcceptanceEvidenceInputError";
}

export const loadM0AcceptanceEvidence = async (
  path: string | undefined,
): Promise<M0AcceptanceEvidence | undefined> => {
  if (path === undefined) {
    return undefined;
  }
  let evidence: M0AcceptanceEvidence;
  try {
    const content = await readFile(path, "utf8");
    evidence = m0AcceptanceEvidenceSchema.parse(
      JSON.parse(content.replace(/^\uFEFF/u, "")) as unknown,
    );
  } catch (error) {
    throw new M0AcceptanceEvidenceInputError(
      error instanceof SyntaxError
        ? "M0 acceptance evidence JSON is invalid."
        : error instanceof z.ZodError
          ? "M0 acceptance evidence schema is invalid."
          : "M0 acceptance evidence could not be read.",
      {
        cause: error,
      },
    );
  }
  if (containsKnownSecret(JSON.stringify(evidence))) {
    throw new M0AcceptanceEvidenceInputError(
      "M0 acceptance evidence contains a secret.",
    );
  }
  return evidence;
};
