import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  readdir,
  readFile,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  join,
} from "node:path";
import { replaceFileAtomically } from "./atomic-rename.js";

import {
  PROVENLOOP_CAPABILITIES,
  type ProvenLoopCapability,
} from "@provenloop/contracts";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";

export interface ExperimentalSettingState {
  readonly managed: boolean;
  readonly previousValue: boolean | "missing";
}

export interface PersistedCapabilityState {
  readonly enabled: boolean;
  readonly lastError?: string;
}

export interface PersistedCopilotAdapterState {
  readonly automaticLearning?: AutomaticLearningPreferences;
  readonly capabilities: Readonly<
    Record<ProvenLoopCapability, PersistedCapabilityState>
  >;
  readonly detectedCopilotVersion?: string;
  readonly experimentalSetting?: ExperimentalSettingState;
  readonly installed: boolean;
  readonly marketplaceRegistered: boolean;
  readonly pluginEnabled: boolean;
  readonly pluginInstalled: boolean;
  readonly schemaVersion: 1;
  readonly updatedAt: string;
}

export interface AutomaticLearningPreferences {
  // Preserve historical acknowledgements without inventing one for automatic defaults.
  readonly consentedAt?: string;
  readonly disclosureVersion?: 1;
  readonly enabled?: boolean;
  readonly notificationsEnabled: boolean;
}
export type AutomaticLearningConsent = AutomaticLearningPreferences;

export const AUTOMATIC_LEARNING_DISCLOSURE =
  "Automatic learning runs when installation, capture, worker, and correction learning are enabled, unless you explicitly disable it. It processes user corrections and captured agent research/recovery summaries, sending bounded, redacted conversation and tool excerpts to GitHub Copilot using your existing sign-in and service quota. It uses isolated background requests with tools disabled; Copilot service usage and retention policies apply. New reusable conventions and references receive a separate bounded model quality review before retention. Both requests count toward the service quota. Idle learning also sends bounded saved lesson text and conditions to the same provider to classify existing experience; extraction and independent review use the same daily budget. Accepted lessons are returned concisely with scope and evidence available through Explain; model review is not external verification or user confirmation. Older source-checked entries keep their quoted delivery mode. Use provenloop learning disable to opt out. You can also mute notices, revoke rules, or delete their sources.";

export const resolveAutomaticLearning = (state: PersistedCopilotAdapterState) => {
  const prerequisites = {
    installed: state.installed,
    capture: state.capabilities.capture.enabled,
    worker: state.capabilities.worker.enabled,
    correctionLearning: state.capabilities.correction_learning.enabled,
  };
  const blockedBy = Object.entries(prerequisites).filter(([, enabled]) => !enabled).map(([name]) => name);
  const mode = state.automaticLearning?.enabled === false ? "disabled" as const
    : state.automaticLearning?.enabled === true ? "enabled" as const : "automatic" as const;
  if (mode === "disabled") blockedBy.unshift("explicitly_disabled");
  return {
    ...state.automaticLearning,
    enabled: blockedBy.length === 0,
    mode, prerequisites, blockedBy, consentRequired: false,
    notificationsEnabled: state.automaticLearning?.notificationsEnabled ?? true,
  };
};

const parseAutomaticLearning = (input: unknown, path: string): AutomaticLearningPreferences | undefined => {
  if (input === undefined) return undefined;
  if (!isRecord(input) ||
      ((input.consentedAt !== undefined || input.disclosureVersion !== undefined) &&
        (input.disclosureVersion !== 1 || typeof input.consentedAt !== "string" || !Number.isFinite(Date.parse(input.consentedAt)))) ||
      (input.enabled !== undefined && typeof input.enabled !== "boolean") || typeof input.notificationsEnabled !== "boolean") {
    throw new InvalidCopilotAdapterStateError(path);
  }
  return {
    ...(typeof input.consentedAt === "string" ? { consentedAt: input.consentedAt, disclosureVersion: 1 as const } : {}),
    ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
    notificationsEnabled: input.notificationsEnabled,
  };
};

export class InvalidCopilotAdapterStateError extends Error {
  public override readonly name = "InvalidCopilotAdapterStateError";

  public constructor(path: string) {
    super(`Copilot adapter state is malformed: ${path}.`);
  }
}

export class InvalidCopilotSettingsError extends Error {
  public override readonly name = "InvalidCopilotSettingsError";

  public constructor(path: string, detail: string) {
    super(`Copilot settings are malformed at ${path}: ${detail}`);
  }
}

const isRecord = (
  input: unknown,
): input is Readonly<Record<string, unknown>> =>
  input !== null && typeof input === "object" && !Array.isArray(input);

const defaultCapabilities = (): Readonly<
  Record<ProvenLoopCapability, PersistedCapabilityState>
> => ({
  capture: {
    enabled: false,
  },
  worker: {
    enabled: false,
  },
  retrieval: {
    enabled: false,
  },
  correction_learning: {
    enabled: false,
  },
  outcome_learning: {
    enabled: false,
  },
  retrospective: {
    enabled: false,
  },
  playbook: {
    enabled: false,
  },
  external_research: {
    enabled: false,
  },
});

export const createDefaultCopilotAdapterState = (
  now: Date,
): PersistedCopilotAdapterState => ({
  capabilities: defaultCapabilities(),
  installed: false,
  marketplaceRegistered: false,
  pluginEnabled: false,
  pluginInstalled: false,
  schemaVersion: 1,
  updatedAt: now.toISOString(),
});

const parseCapabilityState = (
  input: unknown,
  path: string,
): PersistedCapabilityState => {
  if (!isRecord(input) || typeof input.enabled !== "boolean") {
    throw new InvalidCopilotAdapterStateError(path);
  }
  if (
    input.lastError !== undefined &&
    typeof input.lastError !== "string"
  ) {
    throw new InvalidCopilotAdapterStateError(path);
  }
  return {
    enabled: input.enabled,
    ...(input.lastError === undefined
      ? {}
      : {
          lastError: input.lastError,
        }),
  };
};

const parseExperimentalSetting = (
  input: unknown,
  path: string,
): ExperimentalSettingState | undefined => {
  if (input === undefined) {
    return undefined;
  }
  if (
    !isRecord(input) ||
    typeof input.managed !== "boolean" ||
    (
      input.previousValue !== "missing" &&
      typeof input.previousValue !== "boolean"
    )
  ) {
    throw new InvalidCopilotAdapterStateError(path);
  }
  return {
    managed: input.managed,
    previousValue: input.previousValue,
  };
};

const parseState = (
  input: unknown,
  path: string,
): PersistedCopilotAdapterState => {
  if (
    !isRecord(input) ||
    input.schemaVersion !== 1 ||
    typeof input.installed !== "boolean" ||
    typeof input.marketplaceRegistered !== "boolean" ||
    typeof input.pluginEnabled !== "boolean" ||
    typeof input.pluginInstalled !== "boolean" ||
    typeof input.updatedAt !== "string" ||
    !isRecord(input.capabilities)
  ) {
    throw new InvalidCopilotAdapterStateError(path);
  }
  const capabilityRecord = input.capabilities;
  if (
    input.detectedCopilotVersion !== undefined &&
    typeof input.detectedCopilotVersion !== "string"
  ) {
    throw new InvalidCopilotAdapterStateError(path);
  }
  const capabilities = Object.fromEntries(
    PROVENLOOP_CAPABILITIES.map((capability) => [
      capability,
      parseCapabilityState(capabilityRecord[capability], path),
    ]),
  ) as Record<ProvenLoopCapability, PersistedCapabilityState>;
  const experimentalSetting = parseExperimentalSetting(
    input.experimentalSetting,
    path,
  );
  const automaticLearning = parseAutomaticLearning(input.automaticLearning, path);
  return {
    ...(automaticLearning === undefined ? {} : { automaticLearning }),
    capabilities,
    installed: input.installed,
    marketplaceRegistered: input.marketplaceRegistered,
    pluginEnabled: input.pluginEnabled,
    pluginInstalled: input.pluginInstalled,
    schemaVersion: 1,
    updatedAt: input.updatedAt,
    ...(input.detectedCopilotVersion === undefined
      ? {}
      : {
          detectedCopilotVersion: input.detectedCopilotVersion,
        }),
    ...(experimentalSetting === undefined
      ? {}
      : {
          experimentalSetting,
        }),
  };
};

const atomicWrite = async (
  path: string,
  content: string,
): Promise<void> => {
  await mkdir(dirname(path), {
    recursive: true,
  });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await replaceFileAtomically(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

export const readCopilotAdapterState = async (
  path: string,
  now: Date,
): Promise<PersistedCopilotAdapterState> => {
  try {
    return parseState(
      JSON.parse(await readFile(path, "utf8")) as unknown,
      path,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return createDefaultCopilotAdapterState(now);
    }
    if (error instanceof InvalidCopilotAdapterStateError) {
      throw error;
    }
    throw new InvalidCopilotAdapterStateError(path);
  }
};

export const writeCopilotAdapterState = (
  path: string,
  state: PersistedCopilotAdapterState,
): Promise<void> =>
  atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);

interface ParsedSettings {
  readonly content: string;
  readonly experimental: boolean | "missing";
}

const readSettings = async (path: string): Promise<ParsedSettings> => {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      content = "{}\n";
    } else {
      throw error;
    }
  }
  const errors: ParseError[] = [];
  const parsed = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (errors.length > 0 || !isRecord(parsed)) {
    const firstError = errors[0];
    const detail =
      firstError === undefined
        ? "the root value must be an object."
        : printParseErrorCode(firstError.error);
    throw new InvalidCopilotSettingsError(path, detail);
  }
  if (
    parsed.experimental !== undefined &&
    typeof parsed.experimental !== "boolean"
  ) {
    throw new InvalidCopilotSettingsError(
      path,
      "experimental must be a boolean.",
    );
  }
  return {
    content,
    experimental:
      parsed.experimental === undefined
        ? "missing"
        : parsed.experimental,
  };
};

const writeExperimental = async (
  path: string,
  settings: ParsedSettings,
  value: boolean | "missing",
): Promise<void> => {
  const edits = modify(
    settings.content,
    [
      "experimental",
    ],
    value === "missing" ? undefined : value,
    {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    },
  );
  await atomicWrite(path, applyEdits(settings.content, edits));
};

export const ensureExperimentalSetting = async (
  path: string,
  tracked?: ExperimentalSettingState,
): Promise<ExperimentalSettingState> => {
  const settings = await readSettings(path);
  const state =
    tracked ?? {
      managed: settings.experimental !== true,
      previousValue: settings.experimental,
    };
  if (settings.experimental !== true) {
    await writeExperimental(path, settings, true);
  }
  return state;
};

export const assertExperimentalSettingRestorable = async (
  path: string,
  tracked: ExperimentalSettingState | undefined,
): Promise<void> => {
  if (tracked?.managed) {
    await readSettings(path);
  }
};

export const restoreExperimentalSetting = async (
  path: string,
  tracked: ExperimentalSettingState | undefined,
): Promise<void> => {
  if (!tracked?.managed) {
    return;
  }
  const settings = await readSettings(path);
  if (settings.experimental !== true) {
    return;
  }
  await writeExperimental(path, settings, tracked.previousValue);
};

export const readInternalSessionIds = async (
  path: string,
): Promise<ReadonlySet<string>> => {
  let names: readonly string[];
  try {
    names = await readdir(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return new Set();
    }
    throw new InvalidCopilotAdapterStateError(path);
  }
  const sessionIds = new Set<string>();
  for (const name of names.filter((candidate) =>
    candidate.endsWith(".json"),
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(join(path, name), "utf8"),
      ) as unknown;
    } catch {
      throw new InvalidCopilotAdapterStateError(join(path, name));
    }
    if (
      !isRecord(parsed) ||
      typeof parsed.sessionId !== "string" ||
      parsed.sessionId.trim().length === 0
    ) {
      throw new InvalidCopilotAdapterStateError(join(path, name));
    }
    sessionIds.add(parsed.sessionId.trim());
  }
  return sessionIds;
};

const internalSessionPath = (
  root: string,
  sessionId: string,
): string =>
  join(
    root,
    `${createHash("sha256").update(sessionId).digest("hex")}.json`,
  );

export const writeInternalSessionId = async (
  path: string,
  sessionId: string,
): Promise<void> =>
  atomicWrite(
    internalSessionPath(path, sessionId),
    `${JSON.stringify({
      sessionId,
    }, null, 2)}\n`,
  );

export const removeInternalSessionId = (
  path: string,
  sessionId: string,
): Promise<void> =>
  rm(internalSessionPath(path, sessionId), {
    force: true,
  });

export const setPersistedCapability = (
  state: PersistedCopilotAdapterState,
  capability: ProvenLoopCapability,
  value: PersistedCapabilityState,
  now: Date,
): PersistedCopilotAdapterState => ({
  ...state,
  capabilities: {
    ...state.capabilities,
    [capability]: value,
  },
  updatedAt: now.toISOString(),
});

export const clearExperimentalSettingState = (
  state: PersistedCopilotAdapterState,
  now: Date,
): PersistedCopilotAdapterState => ({
  ...(state.automaticLearning === undefined ? {} : { automaticLearning: state.automaticLearning }),
  capabilities: state.capabilities,
  installed: state.installed,
  marketplaceRegistered: state.marketplaceRegistered,
  pluginEnabled: state.pluginEnabled,
  pluginInstalled: state.pluginInstalled,
  schemaVersion: 1,
  updatedAt: now.toISOString(),
  ...(state.detectedCopilotVersion === undefined
    ? {}
    : {
        detectedCopilotVersion: state.detectedCopilotVersion,
      }),
});
