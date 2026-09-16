import {
  readdir,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CopilotSessionFileDescriptor {
  readonly modifiedAt: string;
  readonly path: string;
  readonly sessionId: string;
  readonly sizeBytes: number;
}

export interface DiscoverCopilotSessionFilesOptions {
  readonly maxSessions: number;
  readonly modifiedSince?: Date;
}

export class InvalidSessionDiscoveryConfigurationError extends Error {
  public override readonly name =
    "InvalidSessionDiscoveryConfigurationError";

  public constructor() {
    super("Session discovery maxSessions must be a positive integer.");
  }
}

export const resolveCopilotSessionStateRoot = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  userHome = homedir(),
): string => {
  const configuredHome = environment.COPILOT_HOME?.trim();
  return join(
    configuredHome && configuredHome.length > 0
      ? configuredHome
      : join(userHome, ".copilot"),
    "session-state",
  );
};

export const discoverCopilotSessionFiles = async (
  root: string,
  options: DiscoverCopilotSessionFilesOptions,
): Promise<readonly CopilotSessionFileDescriptor[]> => {
  if (
    !Number.isInteger(options.maxSessions) ||
    options.maxSessions <= 0
  ) {
    throw new InvalidSessionDiscoveryConfigurationError();
  }
  const entries = await readdir(root, {
    withFileTypes: true,
  });
  const descriptors = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(root, entry.name, "events.jsonl");
        try {
          const metadata = await stat(path);
          if (
            !metadata.isFile() ||
            (
              options.modifiedSince !== undefined &&
              metadata.mtimeMs < options.modifiedSince.getTime()
            )
          ) {
            return undefined;
          }
          return {
            modifiedAt: metadata.mtime.toISOString(),
            path,
            sessionId: entry.name,
            sizeBytes: metadata.size,
          };
        } catch (error) {
          if (
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return undefined;
          }
          throw error;
        }
      }),
  );
  return descriptors
    .filter(
      (
        descriptor,
      ): descriptor is CopilotSessionFileDescriptor =>
        descriptor !== undefined,
    )
    .sort(
      (left, right) =>
        right.modifiedAt.localeCompare(left.modifiedAt) ||
        left.sessionId.localeCompare(right.sessionId),
    )
    .slice(0, options.maxSessions);
};
