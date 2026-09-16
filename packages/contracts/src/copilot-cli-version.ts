export const MINIMUM_COPILOT_CLI_VERSION = "1.0.71";
export const SUPPORTED_COPILOT_CLI_VERSION_RANGE =
  `>=${MINIMUM_COPILOT_CLI_VERSION}`;

export const VERIFIED_COPILOT_CLI_VERSIONS = [
  "1.0.82-0",
  "1.0.83-4",
] as const;

interface CopilotCliVersion {
  readonly build: number;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const versionPattern =
  /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9]+))?$/u;

const isSafeVersionComponent = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

export const parseCopilotCliVersion = (
  value: string,
): CopilotCliVersion | undefined => {
  const match = versionPattern.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const build = Number(match[4] ?? "0");
  if (
    !isSafeVersionComponent(major) ||
    !isSafeVersionComponent(minor) ||
    !isSafeVersionComponent(patch) ||
    !isSafeVersionComponent(build)
  ) {
    return undefined;
  }
  return {
    build,
    major,
    minor,
    patch,
  };
};

export const isSupportedCopilotCliVersion = (
  value: string,
): boolean => {
  const version = parseCopilotCliVersion(value);
  if (version === undefined) {
    return false;
  }
  return (
    version.major > 1 ||
    (
      version.major === 1 &&
      (
        version.minor > 0 ||
        (version.minor === 0 && version.patch >= 71)
      )
    )
  );
};

export const isVerifiedCopilotCliVersion = (
  value: string,
): boolean =>
  VERIFIED_COPILOT_CLI_VERSIONS.some(
    (candidate) => candidate === value,
  );
