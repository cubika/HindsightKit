import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export interface WindowsProvenLoopPaths {
  readonly adapterState: string;
  readonly artifacts: string;
  readonly backends: string;
  readonly data: string;
  readonly database: string;
  readonly evaluation: string;
  readonly heartbeat: string;
  readonly integration: string;
  readonly internalSessions: string;
  readonly knowledgeDatabase: string;
  readonly logs: string;
  readonly projectionDirty: string;
  readonly queue: string;
  readonly root: string;
  readonly rootMarker: string;
  readonly temporary: string;
}

export class LocalAppDataUnavailableError extends Error {
  public override readonly name = "LocalAppDataUnavailableError";

  public constructor() {
    super("LOCALAPPDATA is required to resolve the ProvenLoop data root.");
  }
}

export const resolveWindowsProvenLoopDataRoot = (
  environment: Readonly<Record<string, string | undefined>> =
    process.env,
): string => {
  const localAppData = environment.LOCALAPPDATA?.trim();
  if (!localAppData) {
    throw new LocalAppDataUnavailableError();
  }
  return resolve(localAppData, "ProvenLoop");
};

export const resolveWindowsProvenLoopPaths = (
  root: string,
): WindowsProvenLoopPaths => {
  const resolvedRoot = resolve(root);
  const data = resolve(resolvedRoot, "data");
  const integration = resolve(resolvedRoot, "integration");
  return {
    adapterState: resolve(data, "adapter-state.json"),
    artifacts: resolve(resolvedRoot, "artifacts"),
    backends: resolve(resolvedRoot, "backends"),
    data,
    database: resolve(data, "provenloop.db"),
    evaluation: resolve(resolvedRoot, "evaluation"),
    heartbeat: resolve(data, "worker-heartbeat.json"),
    integration,
    internalSessions: resolve(data, "internal-sessions"),
    knowledgeDatabase: resolve(
      resolvedRoot,
      "backends",
      "knowledge.db",
    ),
    logs: resolve(resolvedRoot, "logs"),
    projectionDirty: resolve(data, "projection-dirty.json"),
    queue: resolve(resolvedRoot, "queue"),
    root: resolvedRoot,
    rootMarker: resolve(resolvedRoot, ".provenloop-root.json"),
    temporary: resolve(resolvedRoot, "temp"),
  };
};

export const resolveWindowsProvenLoopLeaseName = async (
  root: string,
  purpose: string,
): Promise<string> => {
  const normalizedPurpose = purpose
    .trim()
    .replaceAll(/[^A-Za-z0-9_-]/gu, "-");
  if (normalizedPurpose.length === 0) {
    throw new Error("ProvenLoop lease purpose must be non-empty.");
  }
  const resolvedRoot = resolve(root);
  let canonicalRoot = resolvedRoot;
  try {
    canonicalRoot = await realpath(resolvedRoot);
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )
    ) {
      throw error;
    }
  }
  const rootDigest = createHash("sha256")
    .update(canonicalRoot.toLocaleLowerCase("en-US"))
    .digest("hex")
    .slice(0, 24);
  return `${normalizedPurpose}-${rootDigest}`;
};

export const resolveWindowsCaptureWorkerLeaseName = (
  root: string,
): Promise<string> =>
  resolveWindowsProvenLoopLeaseName(root, "capture-worker");
