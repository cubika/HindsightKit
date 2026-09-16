import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface ExternalReportArtifact {
  readonly path: string;
  readonly sha256: string;
}

export const verifyExternalReportArtifacts = async (
  artifacts: readonly ExternalReportArtifact[],
  requiredDigests: readonly string[],
  root: string | undefined,
): Promise<void> => {
  if (root === undefined || artifacts.length === 0) {
    throw new Error("External report artifacts and their root directory are required.");
  }
  const realRoot = await realpath(root);
  const supplied = new Set<string>();
  for (const artifact of artifacts) {
    if (
      !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      supplied.has(artifact.sha256) ||
      isAbsolute(artifact.path) ||
      artifact.path.includes(":") ||
      artifact.path.split(/[\\/]/u).some((part) => part === ".." || part === "")
    ) {
      throw new Error("External report artifact reference is invalid.");
    }
    const path = await realpath(resolve(realRoot, artifact.path));
    const within = relative(realRoot, path);
    if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
      throw new Error("External report artifact escaped its evidence directory.");
    }
    const file = await open(path, "r");
    try {
      const details = await file.stat();
      if (!details.isFile() || details.size > 8 * 1024 * 1024) {
        throw new Error("External report artifact is not a bounded file.");
      }
      const bytes = await file.readFile();
      if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
        throw new Error("External report artifact digest does not match.");
      }
    } finally {
      await file.close();
    }
    supplied.add(artifact.sha256);
  }
  if (requiredDigests.some((digest) => !supplied.has(digest))) {
    throw new Error("A required external report artifact is missing.");
  }
};
