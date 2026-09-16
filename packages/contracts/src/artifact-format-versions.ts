export type ArtifactFormatKind =
  | "fixture"
  | "migration"
  | "report"
  | "schema";

export const ARTIFACT_FORMAT_VERSIONS = {
  fixture: 1,
  migration: 1,
  report: 1,
  schema: 1,
} as const satisfies Readonly<Record<ArtifactFormatKind, number>>;
