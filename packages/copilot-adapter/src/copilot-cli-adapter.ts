import { randomUUID } from "node:crypto";
import {
  access,
  constants,
  mkdir,
  readFile,
  rename,
  rm,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { cancelLearningScratch } from "./inference-supervisor.js";
import { stopPluginProcesses } from "./stop-plugin-processes.js";
import { refreshPluginFiles } from "./refresh-plugin-files.js";
import { bundledPluginAssets } from "./plugin-assets.js";
import {
  join,
  parse as parsePath,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";

import {
  isSupportedCopilotCliVersion,
  isVerifiedCopilotCliVersion,
  PROVENLOOP_CAPABILITIES,
  PROVENLOOP_VERSION,
  type AdapterCapabilityAvailability,
  type AdapterCapabilityMatrix,
  type AdapterCapabilityState,
  type AdapterCompatibility,
  type AdapterDoctorOptions,
  type AdapterHealth,
  type AdapterHealthCheck,
  type AdapterInstallOptions,
  type AdapterOperationResult,
  type AdapterStatus,
  type AgentAdapter,
  type ProvenLoopCapability,
  type RuntimeContext,
  type SessionIdentity,
} from "@provenloop/contracts";
import {
  isProvenLoopInternalEnvironment,
  sanitizeDiagnostic,
} from "@provenloop/domain";
import {
  beginExtensionShutdown,
  beginUpgradeMaintenance,
  waitForMaintenanceLease,
  resolveWindowsCaptureWorkerLeaseName,
  resolveWindowsProvenLoopLeaseName,
  resolveWindowsProvenLoopPaths,
  waitForActiveExtensionsToStop,
  WindowsCaptureQueue,
  WindowsNamedPipeLeaseProvider,
  type WindowsProvenLoopPaths,
} from "@provenloop/platform-windows";
import {
  CanonicalSqliteStore,
  DEFAULT_SQLITE_MIGRATIONS,
} from "@provenloop/storage-sqlite";

import { getCopilotCaptureCapability } from "./capabilities.js";
import {
  type CommandResult,
  type CommandRunner,
  SpawnCommandRunner,
} from "./command-runner.js";
import {
  CopilotEventMapper,
  type CopilotEventMappingResult,
} from "./event-mapper.js";
import {
  assertExperimentalSettingRestorable,
  clearExperimentalSettingState,
  ensureExperimentalSetting,
  readCopilotAdapterState,
  resolveAutomaticLearning,
  readInternalSessionIds,
  removeInternalSessionId,
  restoreExperimentalSetting,
  setPersistedCapability,
  writeInternalSessionId,
  writeCopilotAdapterState,
  type PersistedCopilotAdapterState,
} from "./operational-state.js";

const DEFAULT_COPILOT_MARKETPLACE_NAME =
  "provenloop-marketplace";
const DEFAULT_COPILOT_MARKETPLACE_SOURCE =
  `cubika/ProvenLoop#v${PROVENLOOP_VERSION}`;
const COPILOT_PLUGIN_NAME = "provenloop";
const REQUIRED_COPILOT_PLUGIN_COMMANDS = [
  {
    args: [
      "plugin",
      "marketplace",
      "list",
      "--help",
    ],
    operation: "Plugin Marketplace support",
  },
  {
    args: [
      "plugin",
      "install",
      "--help",
    ],
    operation: "Plugin installation support",
  },
  {
    args: [
      "plugins",
      "enable",
      "--help",
    ],
    operation: "Plugin enablement support",
  },
  {
    args: [
      "plugins",
      "disable",
      "--help",
    ],
    operation: "Plugin disablement support",
  },
] as const;
const DATA_ROOT_MARKER_PRODUCT = "ProvenLoop";
const RUNTIME_LOCATOR_PRODUCT = "ProvenLoopRuntime";
const PLUGIN_CAPABILITIES = new Set<ProvenLoopCapability>([
  "capture",
  "retrieval",
]);
const COPILOT_COMMAND_TIMEOUT_MS = 15_000;
const GIT_COMMAND_TIMEOUT_MS = 5_000;
const STATE_LEASE_TIMEOUT_MS = 5_000;
const STATE_LEASE_RETRY_DELAY_MS = 25;
const EXTENSION_SHUTDOWN_TIMEOUT_MS = 6_000;
const INCOMPLETE_UPGRADE_RECOVERY_ERROR =
  "Schema upgrade recovery is incomplete; review the retained snapshot before resuming.";

export interface CopilotCliAdapterOptions {
  readonly stopOwnedPluginProcesses?: () => Promise<unknown>;
  readonly refreshLockedPlugin?: () => Promise<{ rollback(): Promise<void> }>;
  readonly upgradeDrainTimeoutMs?: number;
  readonly cliBinPath?: string;
  readonly commandRunner?: CommandRunner;
  readonly copilotHome?: string;
  readonly dataRoot: string;
  readonly environment?: Readonly<
    Record<string, string | undefined>
  >;
  readonly extensionModuleUrl?: string;
  readonly integrationLocatorPath?: string;
  readonly marketplace?: {
    readonly name: string;
    readonly source: string;
    readonly writeLocalAssets?: boolean;
  };
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
}

export class CopilotCommandError extends Error {
  public override readonly name = "CopilotCommandError";

  public constructor(operation: string, result: CommandResult) {
    const detail = sanitizeDiagnostic(
      result.stderr.trim() || result.stdout.trim() || "unknown failure",
    );
    super(`Copilot ${operation} failed: ${detail}`);
  }
}

const isRecord = (
  input: unknown,
): input is Readonly<Record<string, unknown>> =>
  input !== null && typeof input === "object" && !Array.isArray(input);

const optionalText = (value: string): string | undefined => {
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
};

const marketplaceSourceMatches = (
  actual: string | undefined,
  expected: string,
): boolean => {
  if (actual === expected) {
    return true;
  }
  const separator = expected.lastIndexOf("#");
  if (separator === -1) {
    return false;
  }
  const repository = expected.slice(0, separator);
  const reference = expected.slice(separator + 1);
  const normalized = actual?.replaceAll(/\s+/gu, " ").trim();
  return [
    `${repository}#${reference}`,
    `${repository}@${reference}`,
    `${repository}, ref: ${reference}`,
    `${repository} ref: ${reference}`,
  ].includes(normalized ?? "");
};

const compatibilityForVersion = (
  version: string | undefined,
): AdapterCompatibility => {
  if (version === undefined) {
    return "unavailable";
  }
  return !isSupportedCopilotCliVersion(version)
    ? "incompatible"
    : "supported";
};

const capabilityAvailability = (
  capability: ProvenLoopCapability,
  compatibility: AdapterCompatibility,
): AdapterCapabilityAvailability => {
  if (capability === "worker") {
    return "available";
  }
  if (
    capability === "capture" ||
    capability === "retrieval" ||
    capability === "correction_learning"
  ) {
    return compatibility === "supported"
      ? "available"
      : compatibility;
  }
  return "unavailable";
};

const healthStatus = (
  checks: readonly AdapterHealthCheck[],
): AdapterHealth["status"] =>
  checks.some((check) => check.status === "fail")
    ? "unhealthy"
    : checks.some((check) => check.status === "warn")
      ? "degraded"
      : "healthy";

const errnoCode = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const escapedPattern = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const sectionLines = (
  output: string,
  heading: string,
): readonly string[] => {
  const lines = output.split(/\r?\n/u);
  const start = lines.findIndex(
    (line) => line.trim() === heading,
  );
  if (start === -1) {
    return [];
  }
  const selected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S.*:\s*$/u.test(line)) {
      break;
    }
    selected.push(line);
  }
  return selected;
};

interface CopilotRegistrationStatus {
  readonly marketplaceRegistered: boolean;
  readonly marketplaceSource?: string;
  readonly pluginEnabled: boolean;
  readonly pluginInstalled: boolean;
  readonly pluginVersion?: string;
  readonly registrationError?: string;
}

const stateWith = (
  state: PersistedCopilotAdapterState,
  now: Date,
  update: Partial<
    Omit<PersistedCopilotAdapterState, "schemaVersion" | "updatedAt">
  >,
): PersistedCopilotAdapterState => ({
  ...state,
  ...update,
  schemaVersion: 1,
  updatedAt: now.toISOString(),
});

export const assertCopilotAdapterDataRoot = async (
  paths: WindowsProvenLoopPaths,
): Promise<void> => {
  let marker: unknown;
  try {
    marker = JSON.parse(
      await readFile(paths.rootMarker, "utf8"),
    ) as unknown;
  } catch {
    throw new Error(
      `ProvenLoop data root ownership marker is missing or invalid: ${paths.root}.`,
    );
  }
  if (
    !isRecord(marker) ||
    marker.product !== DATA_ROOT_MARKER_PRODUCT ||
    marker.schemaVersion !== 1 ||
    typeof marker.root !== "string" ||
    resolve(marker.root).toLocaleLowerCase("en-US") !==
      resolve(paths.root).toLocaleLowerCase("en-US")
  ) {
    throw new Error(
      `ProvenLoop data root ownership marker is missing or invalid: ${paths.root}.`,
    );
  }
};

export class CopilotCliAdapter
implements AgentAdapter<CopilotEventMappingResult> {
  readonly #cliBinPath: string;
  readonly #commandRunner: CommandRunner;
  readonly #copilotHome: string;
  readonly #environment: Readonly<
    Record<string, string | undefined>
  >;
  readonly #extensionModuleUrl: string;
  readonly #integrationLocatorPath: string;
  readonly #marketplaceName: string;
  readonly #marketplaceSource: string;
  readonly #now: () => Date;
  readonly #paths: WindowsProvenLoopPaths;
  readonly #platform: NodeJS.Platform;
  readonly #writeLocalMarketplaceAssets: boolean;
  readonly #upgradeDrainTimeoutMs: number;
  readonly #stopOwnedPluginProcesses: () => Promise<unknown>;
  readonly #refreshLockedPlugin: () => Promise<{ rollback(): Promise<void> }>;
  #storageMaintenanceActive = false;

  public constructor(options: CopilotCliAdapterOptions) {
    this.#upgradeDrainTimeoutMs = options.upgradeDrainTimeoutMs ?? 15_000;
    if (!Number.isInteger(this.#upgradeDrainTimeoutMs) || this.#upgradeDrainTimeoutMs < 1 || this.#upgradeDrainTimeoutMs > 60_000) {
      throw new RangeError("Upgrade drain timeout must be between 1 and 60000 milliseconds.");
    }
    this.#paths = resolveWindowsProvenLoopPaths(options.dataRoot);
    this.#commandRunner =
      options.commandRunner ?? new SpawnCommandRunner();
    this.#environment = options.environment ?? process.env;
    this.#copilotHome = resolve(
      options.copilotHome ??
        this.#environment.COPILOT_HOME ??
        join(homedir(), ".copilot"),
    );
    this.#now = options.now ?? (() => new Date());
    this.#platform = options.platform ?? process.platform;
    this.#marketplaceName =
      options.marketplace?.name ??
      DEFAULT_COPILOT_MARKETPLACE_NAME;
    this.#marketplaceSource =
      options.marketplace?.source ??
      DEFAULT_COPILOT_MARKETPLACE_SOURCE;
    this.#writeLocalMarketplaceAssets =
      options.marketplace?.writeLocalAssets ?? false;
    this.#extensionModuleUrl =
      options.extensionModuleUrl ??
      new URL("./extension-entry.js", import.meta.url).href;
    this.#cliBinPath =
      options.cliBinPath ??
      fileURLToPath(new URL("../../cli/dist/bin.js", import.meta.url));
    this.#stopOwnedPluginProcesses = options.stopOwnedPluginProcesses ?? (async () => {
      // Injected command runners use isolated fake hosts; production enumerates only this plugin's processes.
      if (options.commandRunner !== undefined || this.#platform !== "win32") return;
      const localAppData = this.#environment.LOCALAPPDATA?.trim();
      if (!localAppData) {
        throw new Error("LOCALAPPDATA is required to stop owned plugin processes.");
      }
      return stopPluginProcesses({
        dataRoot: this.#paths.root,
        copilotHome: this.#copilotHome,
        localAppData,
        cliBinPath: this.#cliBinPath,
        marketplaceName: this.#marketplaceName,
      });
    });
    this.#refreshLockedPlugin = options.refreshLockedPlugin ?? (async () => {
      const backupRoot = join(this.#paths.data, "backups", "plugin-refresh");
      await mkdir(backupRoot, { recursive: true });
      return refreshPluginFiles({
        pluginRoot: join(
          this.#copilotHome, "installed-plugins",
          this.#marketplaceName, COPILOT_PLUGIN_NAME,
        ),
        copilotHome: this.#copilotHome,
        assets: bundledPluginAssets(),
        version: PROVENLOOP_VERSION,
        marketplaceName: this.#marketplaceName,
        marketplaceSource: this.#marketplaceSource,
        backupRoot,
      });
    });
    const localAppData =
      options.environment === undefined
        ? process.env.LOCALAPPDATA?.trim()
        : options.environment.LOCALAPPDATA?.trim();
    this.#integrationLocatorPath =
      options.integrationLocatorPath ??
      (
        localAppData
          ? resolve(
              localAppData,
              "ProvenLoopIntegration",
              "runtime.json",
            )
          : join(this.#paths.integration, "runtime.json")
      );
  }

  public async capabilities(): Promise<AdapterCapabilityMatrix> {
    const state = await this.#readState();
    const [
      installedVersion,
      registration,
    ] = await Promise.all([
      this.#detectCopilotVersion(),
      this.#registrationStatus(),
    ]);
    const compatibility = compatibilityForVersion(installedVersion);
    const capabilities = PROVENLOOP_CAPABILITIES.map(
      (capability): AdapterCapabilityState => {
        const persisted = state.capabilities[capability];
        const availability = capabilityAvailability(
          capability,
          compatibility,
        );
        const pluginIssue =
          PLUGIN_CAPABILITIES.has(capability) &&
          state.installed &&
          persisted.enabled
            ? registration.registrationError ??
              (
                !marketplaceSourceMatches(
                  registration.marketplaceSource,
                  this.#marketplaceSource,
                )
                  ? `The ProvenLoop marketplace source ${
                      registration.marketplaceSource ?? "unknown"
                    } does not match ${this.#marketplaceSource}.`
                : !registration.pluginInstalled
                  ? "The ProvenLoop Copilot plugin is not installed."
                  : registration.pluginVersion !== PROVENLOOP_VERSION
                    ? `The ProvenLoop Copilot plugin version ${
                        registration.pluginVersion ?? "unknown"
                      } does not match runtime ${PROVENLOOP_VERSION}.`
                  : !registration.pluginEnabled
                    ? "The ProvenLoop Copilot plugin is disabled."
                    : undefined
              )
            : undefined;
        const lastError = persisted.lastError ?? pluginIssue;
        return {
          availability,
          capability,
          enabled:
            availability === "available" &&
            persisted.enabled &&
            (
              !PLUGIN_CAPABILITIES.has(capability) ||
              (
                state.installed &&
                registration.pluginInstalled &&
                registration.pluginEnabled &&
                registration.registrationError === undefined &&
                pluginIssue === undefined
              )
            ),
          ...(lastError === undefined
            ? {}
            : {
                lastError,
              }),
        };
      },
    );
    const capture =
      installedVersion === undefined
        ? undefined
        : getCopilotCaptureCapability(installedVersion);
    return {
      adapter: "copilot-cli",
      capabilities,
      compatibility,
      ...(capture === undefined
        ? {}
        : {
            capture,
          }),
      ...(installedVersion === undefined
        ? {}
        : {
            installedVersion,
          }),
    };
  }

  public install(
    options: AdapterInstallOptions = {},
  ): Promise<AdapterOperationResult> {
    return this.#withStateLease(() => this.#install(options));
  }

  public upgrade(): Promise<AdapterOperationResult> {
    return this.#withStateLease(() => this.#upgrade());
  }

  async #upgrade(): Promise<AdapterOperationResult> {
    if (!await pathExists(this.#paths.database) && !(await this.#readState()).installed) {
      return this.#install();
    }
    await this.#ensureOwnedDataRoot();
    const maintenance = await beginUpgradeMaintenance(this.#paths.root);
    const deadline = Date.now() + this.#upgradeDrainTimeoutMs;
    let workerLease: Awaited<ReturnType<WindowsNamedPipeLeaseProvider["tryAcquire"]>>;
    let projectionLease: Awaited<ReturnType<WindowsNamedPipeLeaseProvider["tryAcquire"]>>;
    let observationsLease: Awaited<ReturnType<WindowsNamedPipeLeaseProvider["tryAcquire"]>>;
    let learningLease: Awaited<ReturnType<WindowsNamedPipeLeaseProvider["tryAcquire"]>>;
    let shutdown: Awaited<ReturnType<typeof beginExtensionShutdown>> | undefined;
    try {
      // Drain before stopping extensions: timeout leaves the existing session running.
      learningLease = await waitForMaintenanceLease(new WindowsNamedPipeLeaseProvider(
        await resolveWindowsProvenLoopLeaseName(this.#paths.root, "learning-inference")), deadline, "learning inference");
      workerLease = await waitForMaintenanceLease(new WindowsNamedPipeLeaseProvider(
        await resolveWindowsCaptureWorkerLeaseName(this.#paths.root)), deadline, "capture worker");
      observationsLease = await waitForMaintenanceLease(new WindowsNamedPipeLeaseProvider(
        await resolveWindowsProvenLoopLeaseName(this.#paths.root, "observations")), deadline, "observation collector");
      projectionLease = await waitForMaintenanceLease(new WindowsNamedPipeLeaseProvider(
        await resolveWindowsProvenLoopLeaseName(this.#paths.root, "knowledge-projection")), deadline, "MCP retrieval or feedback");
      await cancelLearningScratch(join(this.#paths.root, "temp"));
      shutdown = await beginExtensionShutdown(this.#paths.root);
      await waitForActiveExtensionsToStop(this.#paths.root, EXTENSION_SHUTDOWN_TIMEOUT_MS);
      await this.#stopOwnedPluginProcesses();
      await waitForActiveExtensionsToStop(this.#paths.root, EXTENSION_SHUTDOWN_TIMEOUT_MS);
      this.#storageMaintenanceActive = true;
      return await this.#upgradeInMaintenance();
    } finally {
      this.#storageMaintenanceActive = false;
      try {
        await learningLease?.release();
      } finally {
        try {
          await shutdown?.cancel();
        } finally {
          try {
            await observationsLease?.release();
          } finally {
            try { await projectionLease?.release(); } finally {
              try { await workerLease?.release(); } finally { await maintenance.release(); }
            }
          }
        }
      }
    }
  }

  async #upgradeInMaintenance(): Promise<AdapterOperationResult> {
    const version = await this.#detectCopilotVersion();
    if (
      version === undefined ||
      getCopilotCaptureCapability(version) === undefined
    ) {
      return {
        message:
          version === undefined
            ? "GitHub Copilot CLI is unavailable."
            : `GitHub Copilot CLI ${version} is not supported.`,
        status: "incompatible",
      };
    }
    await this.#assertPluginCommandSupport();
    await this.#prepareMarketplaceSource();
    const registration = await this.#requireRegistrationStatus();
    const stateBefore = await this.#readState();
    if (registration.marketplaceRegistered && registration.marketplaceSource === undefined) {
      throw new Error(
        "Cannot safely upgrade because the current ProvenLoop marketplace source is unavailable.",
      );
    }
    const previousSchema = await pathExists(this.#paths.database)
      ? CanonicalSqliteStore.databaseVersion(this.#paths.database)
      : 0;
    const schemaChanges = previousSchema > 0 &&
      previousSchema < (DEFAULT_SQLITE_MIGRATIONS.at(-1)?.version ?? 0);
    const snapshotPath = schemaChanges
      ? join(this.#paths.data, "backups", `pre-upgrade-${randomUUID()}.db`)
      : undefined;
    if (snapshotPath !== undefined) {
      await CanonicalSqliteStore.backupDatabase(
        this.#paths.database, snapshotPath,
        { runtimeVersion: registration.pluginVersion ?? "unknown" },
      );
      if (await pathExists(this.#integrationLocatorPath)) {
        await writeFile(
          `${snapshotPath}.runtime.json`,
          await readFile(this.#integrationLocatorPath, "utf8"),
          "utf8",
        );
      }
    }
    await this.#initializeCoreStorage();
    if (schemaChanges) {
      await this.#markProjectionDirty();
    }
    const migratedDigest = snapshotPath === undefined ? undefined :
      CanonicalSqliteStore.databaseFingerprint(this.#paths.database);
    let replacementStarted = false;
    let refreshedInPlace = false;
    let inPlaceRecovery: { rollback(): Promise<void> } | undefined;
    try {
      if (
        registration.marketplaceRegistered && marketplaceSourceMatches(
          registration.marketplaceSource,
          this.#marketplaceSource,
        )
      ) {
        await this.#runRequired(
          [
            "plugin",
            "marketplace",
            "update",
            this.#marketplaceName,
          ],
          "marketplace update",
        );
      }
      replacementStarted = true;
      if (registration.pluginInstalled) {
        try {
          await this.#runRequired(
            ["plugin", "uninstall", this.#pluginReference()],
            "plugin uninstall before upgrade",
          );
        } catch (error) {
          if (
            this.#platform !== "win32" ||
            !(error instanceof CopilotCommandError) ||
            !/\bos error (?:5|32)\b|Access is denied|being used by another process/iu.test(error.message)
          ) {
            throw error;
          }
          replacementStarted = false;
          inPlaceRecovery = await this.#refreshLockedPlugin();
          refreshedInPlace = true;
        }
      }
      if (!refreshedInPlace && registration.marketplaceRegistered) {
        await this.#runRequired(
          ["plugin", "marketplace", "remove", this.#marketplaceName],
          "marketplace replacement before upgrade",
        );
      }
      if (!refreshedInPlace) {
        await this.#ensureMarketplaceRegistered();
        await this.#runRequired(
          ["plugin", "install", this.#pluginReference()],
          "plugin installation after marketplace upgrade",
        );
      }
      await this.#assertInstalledPluginVersion();
      await this.#ensurePluginEnabled();
      const verifiedRegistration = await this.#requireRegistrationStatus();
      if (
        !verifiedRegistration.pluginEnabled ||
        !verifiedRegistration.marketplaceRegistered ||
        !marketplaceSourceMatches(
          verifiedRegistration.marketplaceSource, this.#marketplaceSource,
        )
      ) {
        throw new Error("The upgraded ProvenLoop registration could not be verified.");
      }
      const store = new CanonicalSqliteStore(this.#paths.database);
      try {
        if (store.health().quickCheck !== "ok") {
          throw new Error("The upgraded ProvenLoop database failed SQLite integrity validation.");
        }
      } finally {
        store.close();
      }
      let state = stateWith(stateBefore, this.#now(), {
        detectedCopilotVersion: version,
        installed: true,
        marketplaceRegistered: true,
        pluginEnabled: true,
        pluginInstalled: true,
      });
      for (const capability of PROVENLOOP_CAPABILITIES) {
        const persisted = state.capabilities[capability];
        if (persisted.lastError === INCOMPLETE_UPGRADE_RECOVERY_ERROR) {
          state = setPersistedCapability(
            state, capability, { enabled: persisted.enabled }, this.#now(),
          );
        }
      }
      await this.#writeState(state);
      await this.#writeRuntimeLocator();
      return {
        message: "ProvenLoop Copilot integration upgraded. Restart existing Copilot sessions to load the matching runtime.",
        status: "changed",
      };
    } catch (error) {
      if (!replacementStarted && snapshotPath === undefined && inPlaceRecovery === undefined) {
        throw error;
      }
      let restorationError: unknown;
      let canonicalDataChanged = false;
      try {
        await inPlaceRecovery?.rollback();
        if (snapshotPath !== undefined) {
          if (
            CanonicalSqliteStore.databaseFingerprint(this.#paths.database) !== migratedDigest
          ) {
            canonicalDataChanged = true;
            let safeState = stateBefore;
            for (const capability of PROVENLOOP_CAPABILITIES) {
              safeState = setPersistedCapability(safeState, capability, {
                enabled: false,
                lastError: "Upgrade recovery requires review; canonical data changed after migration.",
              }, this.#now());
            }
            await this.#writeState(safeState);
            throw new Error(
              `New canonical writes were preserved. Automatic database rollback was refused; verified snapshot: ${snapshotPath}.`,
              { cause: error },
            );
          }
          await CanonicalSqliteStore.restoreFromBackup(snapshotPath, this.#paths.database, {
            migrations: DEFAULT_SQLITE_MIGRATIONS.slice(0, previousSchema),
            ...(migratedDigest === undefined ? {} : {
              expectedTargetFingerprint: migratedDigest,
            }),
          });
        }
        if (replacementStarted && !refreshedInPlace) {
          await this.#restoreRegistration(registration);
        }
        await this.#writeState(stateBefore);
      } catch (restoreError) {
        restorationError = restoreError;
      }
      if (restorationError !== undefined) {
        if (snapshotPath !== undefined && !canonicalDataChanged) {
          let paused = stateBefore;
          for (const capability of PROVENLOOP_CAPABILITIES) {
            paused = setPersistedCapability(paused, capability, {
              enabled: false,
              lastError: INCOMPLETE_UPGRADE_RECOVERY_ERROR,
            }, this.#now());
          }
          await this.#writeState(paused);
        }
        throw new Error(
          "ProvenLoop upgrade failed and could not restore the prior integration: " +
            sanitizeDiagnostic(restorationError),
          {
            cause: error,
          },
        );
      }
      throw new Error(
        (snapshotPath === undefined
          ? "ProvenLoop upgrade failed; the prior integration was restored: "
          : `ProvenLoop upgrade failed; registration and schema ${previousSchema} were restored. Use the previous runtime recorded at ${snapshotPath}.manifest.json or retry upgrade: `) +
          sanitizeDiagnostic(error),
        {
          cause: error,
        },
      );
    }
  }

  async #install(
    options: AdapterInstallOptions = {},
  ): Promise<AdapterOperationResult> {
    let state = await this.#readState();
    if (await this.#databaseNeedsMigration()) {
      const result = await this.#upgrade();
      if (result.status === "incompatible") {
        return result;
      }
      if (!state.installed && options.autoCollect !== false) {
        await this.#enable("capture");
        await this.#enable("worker");
      } else if (options.autoCollect === false) {
        await this.#disable("capture");
        await this.#disable("worker");
      }
      return result;
    }
    if (state.installed) {
      const registration = await this.#requireRegistrationStatus();
      if (
        registration.marketplaceRegistered &&
        registration.pluginInstalled &&
        (
          !marketplaceSourceMatches(
            registration.marketplaceSource,
            this.#marketplaceSource,
          ) ||
          registration.pluginVersion !== PROVENLOOP_VERSION ||
          Object.values(state.capabilities).some((capability) =>
            capability.lastError === INCOMPLETE_UPGRADE_RECOVERY_ERROR,
          )
        )
      ) {
        const result = await this.#upgrade();
        if (options.autoCollect === false) {
          await this.#disable("capture");
          await this.#disable("worker");
        }
        return result;
      }
    }
    await this.#initializeCoreStorage();
    await this.#writeRuntimeLocator();
    const stateWasInstalled = state.installed;
    const collectionBefore = {
      capture: state.capabilities.capture.enabled,
      worker: state.capabilities.worker.enabled,
    };
    const version = await this.#detectCopilotVersion();
    const capability =
      version === undefined
        ? undefined
        : getCopilotCaptureCapability(version);
    state = stateWith(state, this.#now(), {
      ...(version === undefined
        ? {}
        : {
            detectedCopilotVersion: version,
          }),
    });
    if (capability === undefined) {
      const message =
        version === undefined
          ? "GitHub Copilot CLI is unavailable."
          : `GitHub Copilot CLI ${version} is not supported.`;
      state = setPersistedCapability(
        state,
        "capture",
        {
          enabled: false,
          lastError: message,
        },
        this.#now(),
      );
      await this.#writeState(state);
      return {
        message,
        status: "incompatible",
      };
    }

    await this.#assertPluginCommandSupport();
    await this.#writeState(state);
    const before = await this.#requireRegistrationStatus();
    try {
      await this.#prepareMarketplaceSource();
      const experimentalSetting = await ensureExperimentalSetting(
        this.#settingsPath(),
        state.experimentalSetting,
      );
      state = stateWith(state, this.#now(), {
        experimentalSetting,
      });
      await this.#writeState(state);
      await this.#ensureMarketplaceRegistered();
      await this.#ensurePluginInstalled();
      await this.#assertInstalledPluginVersion();
      await this.#ensurePluginEnabled();
      const requestedAutoCollect =
        options.autoCollect ?? (stateWasInstalled ? undefined : true);
      if (requestedAutoCollect !== undefined) {
        for (const capability of [
          "capture",
          "worker",
        ] as const) {
          state = setPersistedCapability(
            state,
            capability,
            {
              enabled: requestedAutoCollect,
            },
            this.#now(),
          );
        }
      }
      state = stateWith(state, this.#now(), {
        installed: true,
        marketplaceRegistered: true,
        pluginEnabled: true,
        pluginInstalled: true,
      });
      await this.#writeState(state);
      const changed =
        !before.marketplaceRegistered ||
        !before.pluginInstalled ||
        !before.pluginEnabled ||
        !stateWasInstalled ||
        collectionBefore.capture !==
          state.capabilities.capture.enabled ||
        collectionBefore.worker !==
          state.capabilities.worker.enabled;
      const autoCollectEnabled =
        state.capabilities.capture.enabled &&
        state.capabilities.worker.enabled;
      return {
        message: changed
          ? autoCollectEnabled
            ? "ProvenLoop Copilot integration installed with automatic collection enabled."
            : "ProvenLoop Copilot integration installed with automatic collection disabled."
          : autoCollectEnabled
            ? "ProvenLoop Copilot integration is already installed with automatic collection enabled."
            : "ProvenLoop Copilot integration is already installed with automatic collection disabled.",
        status: changed ? "changed" : "unchanged",
      };
    } catch (error) {
      state = setPersistedCapability(
        state,
        "capture",
        {
          enabled: false,
          lastError: sanitizeDiagnostic(error),
        },
        this.#now(),
      );
      await this.#writeState(state);
      throw error;
    }
  }

  public async status(): Promise<AdapterStatus> {
    const state = await this.#readState();
    const registration = await this.#registrationStatus();
    return {
      capabilities: await this.capabilities(),
      dataRoot: this.#paths.root,
      installed:
        state.installed &&
        registration.marketplaceRegistered &&
        marketplaceSourceMatches(
          registration.marketplaceSource,
          this.#marketplaceSource,
        ) &&
        registration.pluginInstalled &&
        registration.pluginVersion === PROVENLOOP_VERSION,
      marketplaceRegistered: registration.marketplaceRegistered,
      ...(registration.marketplaceSource === undefined
        ? {}
        : {
            marketplaceSource: registration.marketplaceSource,
          }),
      pluginEnabled: registration.pluginEnabled,
      pluginInstalled: registration.pluginInstalled,
      ...(registration.pluginVersion === undefined
        ? {}
        : {
            pluginVersion: registration.pluginVersion,
          }),
      ...(registration.registrationError === undefined
        ? {}
        : {
            registrationError: registration.registrationError,
          }),
    };
  }

  public enable(
    capability: ProvenLoopCapability,
  ): Promise<AdapterOperationResult> {
    return this.#withStateLease(() => this.#enable(capability));
  }

  async #enable(
    capability: ProvenLoopCapability,
  ): Promise<AdapterOperationResult> {
    let state = await this.#readState();
    const matrix = await this.capabilities();
    const current = matrix.capabilities.find(
      (candidate) => candidate.capability === capability,
    );
    if (current?.availability !== "available") {
      const message =
        `Capability ${capability} is ${current?.availability ?? "unavailable"}.`;
      if (state.installed && await pathExists(this.#paths.root)) {
        await this.#assertOwnedDataRoot();
        state = setPersistedCapability(
          state,
          capability,
          {
            enabled: false,
            lastError: message,
          },
          this.#now(),
        );
        await this.#writeState(state);
      }
      return {
        message,
        status: "incompatible",
      };
    }
    if (
      !state.installed &&
      (
        PLUGIN_CAPABILITIES.has(capability) ||
        capability === "worker"
      )
    ) {
      const message =
        `Capability ${capability} requires provenloop install first.`;
      return {
        message,
        status: "incompatible",
      };
    }
    const alreadyEnabled = current.enabled;
    if (PLUGIN_CAPABILITIES.has(capability)) {
      await this.#assertOwnedDataRoot();
      try {
        await this.#assertPluginCommandSupport();
        if (capability === "capture") {
          const experimentalSetting = await ensureExperimentalSetting(
            this.#settingsPath(),
            state.experimentalSetting,
          );
          state = stateWith(state, this.#now(), {
            experimentalSetting,
          });
          await this.#writeState(state);
        }
        await this.#writeRuntimeLocator();
        await this.#prepareMarketplaceSource();
        await this.#ensureMarketplaceRegistered();
        await this.#ensurePluginInstalled();
        await this.#assertInstalledPluginVersion();
        await this.#ensurePluginEnabled();
        state = stateWith(state, this.#now(), {
          installed: true,
          marketplaceRegistered: true,
          pluginEnabled: true,
          pluginInstalled: true,
        });
      } catch (error) {
        state = setPersistedCapability(
          state,
          capability,
          {
            enabled: false,
            lastError: sanitizeDiagnostic(error),
          },
          this.#now(),
        );
        await this.#writeState(state);
        throw error;
      }
    }
    state = setPersistedCapability(
      state,
      capability,
      {
        enabled: true,
      },
      this.#now(),
    );
    await this.#writeState(state);
    if (
      !alreadyEnabled &&
      (
        capability === "retrieval" ||
        capability === "correction_learning"
      )
    ) {
      await this.#markProjectionDirty();
    }
    return {
      message: alreadyEnabled
        ? `Capability ${capability} is already enabled.`
        : `Capability ${capability} enabled.`,
      status: alreadyEnabled ? "unchanged" : "changed",
    };
  }

  public disable(
    capability: ProvenLoopCapability,
  ): Promise<AdapterOperationResult> {
    return this.#withStateLease(() => this.#disable(capability));
  }

  async #disable(
    capability: ProvenLoopCapability,
  ): Promise<AdapterOperationResult> {
    if (!await pathExists(this.#paths.root)) {
      return {
        message: `Capability ${capability} is already disabled.`,
        status: "unchanged",
      };
    }
    await this.#assertOwnedDataRoot();
    let state = await this.#readState();
    const alreadyDisabled = !state.capabilities[capability].enabled;
    state = setPersistedCapability(
      state,
      capability,
      {
        enabled: false,
      },
      this.#now(),
    );
    if (capability === "capture") {
      await restoreExperimentalSetting(
        this.#settingsPath(),
        state.experimentalSetting,
      );
      state = clearExperimentalSettingState(state, this.#now());
    }
    if (PLUGIN_CAPABILITIES.has(capability)) {
      const pluginCapabilityEnabled = [...PLUGIN_CAPABILITIES].some(
        (candidate) => state.capabilities[candidate].enabled,
      );
      if (!pluginCapabilityEnabled) {
        await this.#ensurePluginDisabled();
        state = stateWith(state, this.#now(), {
          pluginEnabled: false,
        });
      }
    }
    await this.#writeState(state);
    return {
      message: alreadyDisabled
        ? `Capability ${capability} is already disabled.`
        : `Capability ${capability} disabled.`,
      status: alreadyDisabled ? "unchanged" : "changed",
    };
  }

  public uninstall(
    options: {
      readonly purge: boolean;
    },
  ): Promise<AdapterOperationResult> {
    return this.#withStateLease(() => this.#uninstall(options));
  }

  async #uninstall(
    options: {
      readonly purge: boolean;
    },
  ): Promise<AdapterOperationResult> {
    let state = await this.#readState();
    const stateWasInstalled = state.installed;
    const dataRootWasPresent = await pathExists(this.#paths.root);
    if (dataRootWasPresent) {
      await this.#assertOwnedDataRoot();
    }
    await assertExperimentalSettingRestorable(
      this.#settingsPath(),
      state.experimentalSetting,
    );
    let workerLease: Awaited<
      ReturnType<WindowsNamedPipeLeaseProvider["tryAcquire"]>
    >;
    let knowledgeLease: Awaited<
      ReturnType<WindowsNamedPipeLeaseProvider["tryAcquire"]>
    >;
    let observationsLease: Awaited<
      ReturnType<WindowsNamedPipeLeaseProvider["tryAcquire"]>
    >;
    let extensionShutdown:
      | Awaited<ReturnType<typeof beginExtensionShutdown>>
      | undefined;
    try {
      if (options.purge && dataRootWasPresent) {
        const workerLeaseName =
          await resolveWindowsCaptureWorkerLeaseName(
            this.#paths.root,
          );
        workerLease = await new WindowsNamedPipeLeaseProvider(
          workerLeaseName,
        ).tryAcquire();
        if (workerLease === undefined) {
          throw new Error(
            "Cannot purge while the capture worker is active.",
          );
        }
        knowledgeLease = await new WindowsNamedPipeLeaseProvider(
          await resolveWindowsProvenLoopLeaseName(
            this.#paths.root,
            "knowledge-projection",
          ),
        ).tryAcquire();
        if (knowledgeLease === undefined) {
          throw new Error(
            "Cannot purge while retrieval, deletion, or Knowledge projection is active.",
          );
        }
        observationsLease = await new WindowsNamedPipeLeaseProvider(
          await resolveWindowsProvenLoopLeaseName(this.#paths.root, "observations"),
        ).tryAcquire();
        if (observationsLease === undefined) {
          throw new Error("Cannot purge while an observation collector is active.");
        }
        extensionShutdown = await beginExtensionShutdown(
          this.#paths.root,
        );
        await waitForActiveExtensionsToStop(
          this.#paths.root,
          EXTENSION_SHUTDOWN_TIMEOUT_MS,
        );
        await cancelLearningScratch(join(this.#paths.root, "temp"));
      }
      const registration = await this.#requireRegistrationStatus();
    if (
      !stateWasInstalled &&
      !dataRootWasPresent &&
      !registration.pluginInstalled &&
      !registration.marketplaceRegistered
    ) {
      return {
        message: "ProvenLoop integration is already uninstalled.",
        status: "unchanged",
      };
    }
    if (registration.pluginInstalled) {
      await this.#runRequired(
        [
          "plugin",
          "uninstall",
          this.#pluginReference(),
        ],
        "plugin uninstall",
      );
    }
    if (registration.marketplaceRegistered) {
      await this.#runRequired(
        [
          "plugin",
          "marketplace",
          "remove",
          this.#marketplaceName,
        ],
        "marketplace removal",
      );
    }
    await restoreExperimentalSetting(
      this.#settingsPath(),
      state.experimentalSetting,
    );
    state = clearExperimentalSettingState(state, this.#now());
    for (const capability of PROVENLOOP_CAPABILITIES) {
      state = setPersistedCapability(
        state,
        capability,
        {
          enabled: false,
        },
        this.#now(),
      );
    }
    state = stateWith(state, this.#now(), {
      installed: false,
      marketplaceRegistered: false,
      pluginEnabled: false,
      pluginInstalled: false,
    });
    await this.#writeState(state);
    if (options.purge) {
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, 1_200);
      });
    }
    await this.#removeRuntimeLocator();
    await rm(this.#paths.integration, {
      force: true,
      recursive: true,
    });
      if (options.purge) {
        this.#assertSafePurgePath();
        await rm(this.#paths.root, {
          force: true,
          recursive: true,
        });
      }
      const changed =
        registration.pluginInstalled ||
        registration.marketplaceRegistered ||
        stateWasInstalled ||
        (options.purge && dataRootWasPresent);
      return {
        message: options.purge
          ? "ProvenLoop integration uninstalled and local data purged."
          : "ProvenLoop integration uninstalled; local data was preserved.",
        status: changed || options.purge ? "changed" : "unchanged",
      };
    } finally {
      try {
        await extensionShutdown?.cancel();
      } finally {
        try {
          await observationsLease?.release();
        } finally {
          try {
            await knowledgeLease?.release();
          } finally {
            await workerLease?.release();
          }
        }
      }
    }
  }

  public async registerCaptureExtension(): Promise<AdapterOperationResult> {
    return this.install();
  }

  public registerContextTools(): Promise<AdapterOperationResult> {
    return this.#withStateLease(
      () => this.#registerContextTools(),
    );
  }

  async #registerContextTools(): Promise<AdapterOperationResult> {
    await this.#initializeCoreStorage();
    const version = await this.#detectCopilotVersion();
    if (
      version === undefined ||
      getCopilotCaptureCapability(version) === undefined
    ) {
      return {
        message: "A supported GitHub Copilot CLI is required.",
        status: "incompatible",
      };
    }
    await this.#assertPluginCommandSupport();
    const before = await this.#requireRegistrationStatus();
    await this.#writeRuntimeLocator();
    await this.#prepareMarketplaceSource();
    await this.#ensureMarketplaceRegistered();
    await this.#ensurePluginInstalled();
    await this.#assertInstalledPluginVersion();
    await this.#ensurePluginEnabled();
    const state = stateWith(await this.#readState(), this.#now(), {
      detectedCopilotVersion: version,
      installed: true,
      marketplaceRegistered: true,
      pluginEnabled: true,
      pluginInstalled: true,
    });
    await this.#writeState(state);
    return {
      message: before.pluginInstalled
        ? "ProvenLoop local MCP registration already exists."
        : "ProvenLoop local MCP registration created.",
      status: before.pluginInstalled ? "unchanged" : "changed",
    };
  }

  public normalizeEvent(
    input: unknown,
    context: RuntimeContext,
  ): CopilotEventMappingResult {
    if (!isRecord(input)) {
      return {
        issues: [
          "event must be an object.",
        ],
        status: "malformed",
      };
    }
    const mapper = new CopilotEventMapper({
      adapterVersion: context.adapterVersion,
      copyLimits: {
        maxStringChars: 32_768,
      },
      sessionId: context.sessionId,
    });
    return mapper.map(input);
  }

  public async resolveSession(
    context: RuntimeContext,
  ): Promise<SessionIdentity> {
    const sessionId = context.sessionId.trim();
    if (sessionId.length === 0) {
      throw new Error("Runtime context sessionId must be non-empty.");
    }
    const environment = context.environment ?? this.#environment;
    const internalSessionIds = await readInternalSessionIds(
      this.#paths.internalSessions,
    );
    const internalSession =
      isProvenLoopInternalEnvironment(environment) ||
      internalSessionIds.has(sessionId);
    const rootResult = await this.#runGit(
      context.cwd,
      [
        "rev-parse",
        "--show-toplevel",
      ],
    );
    const repositoryRoot =
      rootResult.exitCode === 0
        ? (() => { const path = optionalText(rootResult.stdout); return path === undefined ? undefined : resolve(path); })()
        : undefined;
    if (repositoryRoot === undefined) {
      return {
        internalSession,
        sessionId,
      };
    }
    const [
      branchResult,
      commitParentsResult,
      commonDirectoryResult,
      remoteResult,
    ] = await Promise.all([
      this.#runGit(repositoryRoot, [
        "branch",
        "--show-current",
      ]),
      this.#runGit(repositoryRoot, [
        "rev-list",
        "--parents",
        "-n",
        "1",
        "HEAD",
      ]),
      this.#runGit(repositoryRoot, [
        "rev-parse",
        "--git-common-dir",
      ]),
      this.#runGit(repositoryRoot, [
        "config",
        "--get",
        "remote.origin.url",
      ]),
    ]);
    const commonDirectory =
      commonDirectoryResult.exitCode === 0
        ? optionalText(commonDirectoryResult.stdout)
        : undefined;
    const repositoryId =
      commonDirectory === undefined
        ? repositoryRoot
        : resolve(repositoryRoot, commonDirectory);
    const branch =
      branchResult.exitCode === 0
        ? optionalText(branchResult.stdout)
        : undefined;
    const commitParts =
      commitParentsResult.exitCode === 0
        ? commitParentsResult.stdout.trim().split(/\s+/u)
        : [];
    const commitSha = optionalText(commitParts[0] ?? "");
    const commitParents =
      commitSha === undefined ? undefined : commitParts.slice(1);
    const repositoryRemote =
      remoteResult.exitCode === 0
        ? optionalText(remoteResult.stdout)
        : undefined;
    return {
      internalSession,
      repositoryId,
      repositoryRoot,
      sessionId,
      worktreePath: repositoryRoot,
      ...(branch === undefined
        ? {}
        : {
            branch,
          }),
      ...(commitSha === undefined
        ? {}
        : {
            commitSha,
          }),
      ...(commitParents === undefined
        ? {}
        : {
            commitParents,
          }),
      ...(repositoryRemote === undefined
        ? {}
        : {
            repositoryRemote,
          }),
    };
  }

  public async doctor(
    options: AdapterDoctorOptions = {},
  ): Promise<AdapterHealth> {
    const checks: AdapterHealthCheck[] = [];
    checks.push(this.#nodeCheck());
    checks.push(this.#windowsCheck());
    checks.push(await this.#dataRootCheck());
    checks.push(await this.#sqliteCheck());
    checks.push(await this.#queueCheck());
    checks.push(await this.#workerCheck());
    const status = await this.status();
    checks.push(this.#copilotVersionCheck(status.capabilities));
    const provider = options.online === true
      ? await this.#onlineProviderCheck(
          options.onlineTimeoutMs ?? 15_000,
        )
      : {
          check: {
            id: "copilot.provider",
            message:
              "Provider availability is unverified; use doctor --online for an explicit bounded probe.",
            status: "warn" as const,
          },
          status: "unverified" as const,
        };
    checks.push(provider.check);
    checks.push({
      id: "copilot.extension",
      message:
        status.registrationError ??
        (
          status.pluginInstalled &&
          status.pluginVersion === PROVENLOOP_VERSION
            ? "Copilot Extension plugin registration is present and version-matched."
            : status.pluginInstalled
              ? `Copilot Extension plugin version ${
                  status.pluginVersion ?? "unknown"
                } does not match runtime ${PROVENLOOP_VERSION}.`
            : "Copilot Extension plugin registration is missing."
        ),
      status:
        status.registrationError === undefined &&
        status.pluginInstalled &&
        status.pluginVersion === PROVENLOOP_VERSION
          ? "pass"
          : "fail",
    });
    checks.push({
      id: "copilot.mcp",
      message:
        status.registrationError ??
        (
          status.pluginInstalled &&
          status.pluginVersion === PROVENLOOP_VERSION
            ? "Local MCP registration is present in the version-matched plugin."
            : status.pluginInstalled
              ? `Local MCP plugin version ${
                  status.pluginVersion ?? "unknown"
                } does not match runtime ${PROVENLOOP_VERSION}.`
            : "Local MCP registration is missing."
        ),
      status:
        status.registrationError === undefined &&
        status.pluginInstalled &&
        status.pluginVersion === PROVENLOOP_VERSION
          ? "pass"
          : "fail",
    });
    for (const capability of status.capabilities.capabilities) {
      checks.push({
        id: `capability.${capability.capability}`,
        message:
          capability.lastError ??
          `${capability.capability} is ${capability.availability} and ${
            capability.enabled ? "enabled" : "disabled"
          }.`,
        status:
          capability.lastError === undefined
            ? "pass"
            : capability.availability === "available"
              ? "fail"
              : "warn",
      });
    }
    const learning = resolveAutomaticLearning(await this.#readState());
    checks.push({
      id: "learning.automatic",
      status: learning.enabled || learning.mode === "disabled" ? "pass" : "warn",
      message: learning.enabled
        ? `Automatic learning is enabled (${learning.mode}); eligible captured work can be scheduled. This does not confirm provider availability or completed jobs.`
        : learning.mode === "disabled" ? "Automatic learning was explicitly disabled. Run provenloop learning enable to resume."
          : `Automatic learning is paused; missing prerequisites: ${learning.blockedBy.join(", ")}.`,
    });
    checks.push(await this.#syntheticCaptureCheck());
    return {
      adapter: "copilot-cli",
      checkedAt: this.#now().toISOString(),
      checks,
      providerStatus: provider.status,
      status: healthStatus(checks),
    };
  }

  async #onlineProviderCheck(
    timeoutMs: number,
  ): Promise<{
    readonly check: AdapterHealthCheck;
    readonly status:
      | "available"
      | "incompatible"
      | "rate_limited"
      | "signed_out"
      | "unavailable";
  }> {
    const version = await this.#detectCopilotVersion();
    if (
      version === undefined ||
      getCopilotCaptureCapability(version) === undefined
    ) {
      return {
        check: {
          id: "copilot.provider-online",
          message:
            version === undefined
              ? "Copilot CLI is unavailable."
              : `Copilot CLI ${version} is incompatible.`,
          status: "warn",
        },
        status: version === undefined
          ? "unavailable"
          : "incompatible",
      };
    }
    const result = await this.#commandRunner.run(
      "copilot",
      [
        "--prompt",
        "Reply with exactly PROVENLOOP_OK and no other text.",
        "--silent",
        "--no-custom-instructions",
        "--disable-builtin-mcps",
        "--available-tools=",
        "--no-auto-update",
        "--no-remote",
        "--no-remote-export",
      ],
      {
        environment: {
          COPILOT_HOME: this.#copilotHome,
          PROVENLOOP_INTERNAL: "1",
        },
        timeoutMs,
      },
    );
    const output = `${result.stdout}\n${result.stderr}`.trim();
    let status:
      | "available"
      | "rate_limited"
      | "signed_out"
      | "unavailable";
    if (
      result.exitCode === 0 &&
      result.stdout.trim() === "PROVENLOOP_OK"
    ) {
      status = "available";
    } else if (
      /rate.?limit|quota|too many requests|exceeded/iu.test(output)
    ) {
      status = "rate_limited";
    } else if (
      /sign.?in|log.?in|authenticate|authentication|unauthorized/iu.test(
        output,
      )
    ) {
      status = "signed_out";
    } else {
      status = "unavailable";
    }
    return {
      check: {
        id: "copilot.provider-online",
        message: `Bounded online provider probe classified ${status}.`,
        status: status === "available" ? "pass" : "warn",
      },
      status,
    };
  }

  async #readState(): Promise<PersistedCopilotAdapterState> {
    return readCopilotAdapterState(
      this.#paths.adapterState,
      this.#now(),
    );
  }

  async #withStateLease<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const leaseName = await resolveWindowsProvenLoopLeaseName(
      this.#paths.root,
      "adapter-state",
    );
    const provider = new WindowsNamedPipeLeaseProvider(leaseName);
    const deadline = Date.now() + STATE_LEASE_TIMEOUT_MS;
    let lease = await provider.tryAcquire();
    while (lease === undefined) {
      if (Date.now() >= deadline) {
        throw new Error(
          "Timed out waiting for the ProvenLoop operation lock. Retry the command after the active operation completes.",
        );
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, STATE_LEASE_RETRY_DELAY_MS);
      });
      lease = await provider.tryAcquire();
    }
    try {
      return await operation();
    } finally {
      await lease.release();
    }
  }

  async #writeState(
    state: PersistedCopilotAdapterState,
  ): Promise<void> {
    await assertCopilotAdapterDataRoot(this.#paths);
    await writeCopilotAdapterState(this.#paths.adapterState, state);
  }

  async #writeRuntimeLocator(): Promise<void> {
    const temporaryPath =
      `${this.#integrationLocatorPath}.${randomUUID()}.tmp`;
    await mkdir(
      parsePath(this.#integrationLocatorPath).dir,
      {
        recursive: true,
      },
    );
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify({
          cliBinPath: this.#cliBinPath,
          dataRoot: this.#paths.root,
          extensionModuleUrl: this.#extensionModuleUrl,
          nodeExecutable: process.execPath,
          product: RUNTIME_LOCATOR_PRODUCT,
          schemaVersion: 1,
          version: PROVENLOOP_VERSION,
        }, null, 2)}\n`,
        "utf8",
      );
      await rename(
        temporaryPath,
        this.#integrationLocatorPath,
      );
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async #removeRuntimeLocator(): Promise<void> {
    try {
      const parsed = JSON.parse(
        await readFile(this.#integrationLocatorPath, "utf8"),
      ) as unknown;
      if (
        isRecord(parsed) &&
        parsed.product === RUNTIME_LOCATOR_PRODUCT &&
        parsed.schemaVersion === 1 &&
        parsed.dataRoot === this.#paths.root
      ) {
        await unlink(this.#integrationLocatorPath);
      }
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }

  async #markProjectionDirty(): Promise<void> {
    await writeFile(
      this.#paths.projectionDirty,
      `${JSON.stringify({
        markedAt: this.#now().toISOString(),
        schemaVersion: 1,
      })}\n`,
      "utf8",
    );
  }

  async #initializeCoreStorage(): Promise<void> {
    await this.#ensureOwnedDataRoot();
    await Promise.all([
      mkdir(this.#paths.artifacts, {
        recursive: true,
      }),
      mkdir(this.#paths.backends, {
        recursive: true,
      }),
      mkdir(this.#paths.data, {
        recursive: true,
      }),
      mkdir(this.#paths.evaluation, {
        recursive: true,
      }),
      mkdir(this.#paths.logs, {
        recursive: true,
      }),
      mkdir(this.#paths.queue, {
        recursive: true,
      }),
      mkdir(this.#paths.temporary, {
        recursive: true,
      }),
    ]);
    const queue = new WindowsCaptureQueue(this.#paths.queue);
    await queue.initialize();
    if (!this.#storageMaintenanceActive && await this.#databaseNeedsMigration()) {
      throw new Error("A database migration requires a maintenance upgrade and verified snapshot; run provenloop upgrade.");
    }
    const store = new CanonicalSqliteStore(this.#paths.database, {
      allowSchemaMigration: this.#storageMaintenanceActive,
    });
    store.close();
  }

  async #databaseNeedsMigration(): Promise<boolean> {
    return await pathExists(this.#paths.database) &&
      CanonicalSqliteStore.databaseVersion(this.#paths.database) <
        (DEFAULT_SQLITE_MIGRATIONS.at(-1)?.version ?? 0);
  }

  async #detectCopilotVersion(): Promise<string | undefined> {
    const result = await this.#runCopilot([
      "--version",
    ]);
    if (result.exitCode !== 0) {
      return undefined;
    }
    const match = /GitHub Copilot CLI\s+([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9]+)?)(?:\.|\s|$)/u.exec(
      result.stdout,
    );
    return match?.[1];
  }

  #runCopilot(args: readonly string[]): Promise<CommandResult> {
    return this.#commandRunner.run("copilot", args, {
      environment: {
        ...this.#environment,
        COPILOT_HOME: this.#copilotHome,
      },
      timeoutMs: COPILOT_COMMAND_TIMEOUT_MS,
    });
  }

  #runGit(
    cwd: string,
    args: readonly string[],
  ): Promise<CommandResult> {
    return this.#commandRunner.run(
      "git",
      [
        "-C",
        cwd,
        ...args,
      ],
      {
        environment: this.#environment,
        timeoutMs: GIT_COMMAND_TIMEOUT_MS,
      },
    );
  }

  async #runRequired(
    args: readonly string[],
    operation: string,
  ): Promise<CommandResult> {
    const result = await this.#runCopilot(args);
    if (result.exitCode !== 0) {
      throw new CopilotCommandError(operation, result);
    }
    return result;
  }

  async #assertPluginCommandSupport(): Promise<void> {
    for (const command of REQUIRED_COPILOT_PLUGIN_COMMANDS) {
      await this.#runRequired(command.args, command.operation);
    }
  }

  async #registrationStatus(): Promise<{
    readonly marketplaceRegistered: boolean;
    readonly marketplaceSource?: string;
    readonly pluginEnabled: boolean;
    readonly pluginInstalled: boolean;
    readonly pluginVersion?: string;
    readonly registrationError?: string;
  }> {
    const [
      marketplaces,
      plugins,
    ] = await Promise.all([
      this.#runCopilot([
        "plugin",
        "marketplace",
        "list",
      ]),
      this.#runCopilot([
        "plugin",
        "list",
      ]),
    ]);
    const errors = [
      marketplaces.exitCode === 0
        ? undefined
        : `marketplace list: ${
            marketplaces.stderr.trim() ||
            marketplaces.stdout.trim() ||
            `exit ${marketplaces.exitCode}`
          }`,
      plugins.exitCode === 0
        ? undefined
        : `plugin list: ${
            plugins.stderr.trim() ||
            plugins.stdout.trim() ||
            `exit ${plugins.exitCode}`
          }`,
    ].filter((error): error is string => error !== undefined);
    const marketplacePattern = new RegExp(
      `^\\s*[•◆]?\\s*${escapedPattern(
        this.#marketplaceName,
      )}(?:\\s|\\(|$)`,
      "iu",
    );
    const pluginPattern = new RegExp(
      `^\\s*•?\\s*${escapedPattern(
        COPILOT_PLUGIN_NAME,
      )}@${escapedPattern(
        this.#marketplaceName,
      )}(?:\\s|\\(|$)`,
      "iu",
    );
    const marketplaceLine = sectionLines(
      marketplaces.stdout,
      "Registered marketplaces:",
    ).find((line) => marketplacePattern.test(line));
    const configuredMarketplaceSource =
      await this.#configuredMarketplaceSource();
    const marketplaceSource =
      configuredMarketplaceSource ??
      marketplaceLine?.match(/\([^:]+:\s*([^)]+)\)/u)?.[1]?.trim();
    const pluginLine = plugins.stdout
      .split(/\r?\n/u)
      .find((line) => pluginPattern.test(line));
    const pluginInstalled = pluginLine !== undefined;
    const pluginVersion =
      pluginLine?.match(/\(v([^)\s]+)\)/iu)?.[1];
    const pluginDisabled =
      pluginLine !== undefined &&
      /\bdisabled\b/iu.test(pluginLine);
    return {
      marketplaceRegistered: marketplaceLine !== undefined,
      ...(marketplaceSource === undefined
        ? {}
        : {
            marketplaceSource,
          }),
      pluginEnabled: pluginInstalled && !pluginDisabled,
      pluginInstalled,
      ...(pluginVersion === undefined
        ? {}
        : {
            pluginVersion,
          }),
      ...(errors.length === 0
        ? {}
        : {
            registrationError: sanitizeDiagnostic(errors.join("; ")),
          }),
    };
  }

  async #requireRegistrationStatus(): Promise<CopilotRegistrationStatus> {
    const status = await this.#registrationStatus();
    if (status.registrationError !== undefined) {
      throw new Error(
        `Copilot registration probe failed: ${status.registrationError}`,
      );
    }
    return status;
  }

  async #configuredMarketplaceSource(): Promise<string | undefined> {
    try {
      const parsed = parse(
        await readFile(this.#settingsPath(), "utf8"),
      ) as unknown;
      if (!isRecord(parsed)) {
        return undefined;
      }
      const marketplaces = parsed.extraKnownMarketplaces;
      if (!isRecord(marketplaces)) {
        return undefined;
      }
      const marketplace = marketplaces[this.#marketplaceName];
      if (!isRecord(marketplace)) {
        return undefined;
      }
      const source = marketplace.source;
      if (typeof source === "string") {
        return source.trim() || undefined;
      }
      if (
        !isRecord(source) ||
        typeof source.repo !== "string"
      ) {
        return undefined;
      }
      const repository = source.repo.trim();
      if (!repository) {
        return undefined;
      }
      return typeof source.ref === "string" && source.ref.trim()
        ? `${repository}#${source.ref.trim()}`
        : repository;
    } catch (error) {
      if (errnoCode(error) === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async #restoreRegistration(
    previous: CopilotRegistrationStatus,
  ): Promise<void> {
    const current = await this.#requireRegistrationStatus();
    if (current.pluginInstalled) {
      await this.#runRequired(
        [
          "plugin",
          "uninstall",
          this.#pluginReference(),
        ],
        "plugin uninstall during upgrade recovery",
      );
    }
    if (current.marketplaceRegistered) {
      await this.#runRequired(
        [
          "plugin",
          "marketplace",
          "remove",
          this.#marketplaceName,
        ],
        "marketplace removal during upgrade recovery",
      );
    }
    if (!previous.marketplaceRegistered) {
      return;
    }
    if (previous.marketplaceSource === undefined) {
      throw new Error(
        "The previous ProvenLoop marketplace source is unavailable.",
      );
    }
    await this.#runRequired(
      [
        "plugin",
        "marketplace",
        "add",
        previous.marketplaceSource,
      ],
      "marketplace restoration after upgrade failure",
    );
    if (!previous.pluginInstalled) {
      return;
    }
    await this.#runRequired(
      [
        "plugin",
        "install",
        this.#pluginReference(),
      ],
      "plugin restoration after upgrade failure",
    );
    if (!previous.pluginEnabled) {
      await this.#ensurePluginDisabled();
    }
  }

  async #ensureMarketplaceRegistered(): Promise<void> {
    const status = await this.#requireRegistrationStatus();
    if (
      status.marketplaceRegistered &&
      marketplaceSourceMatches(
        status.marketplaceSource,
        this.#marketplaceSource,
      )
    ) {
      return;
    }
    if (status.pluginInstalled) {
      await this.#runRequired(
        [
          "plugin",
          "uninstall",
          this.#pluginReference(),
        ],
        "plugin uninstall before marketplace replacement",
      );
    }
    if (status.marketplaceRegistered) {
      await this.#runRequired(
        [
          "plugin",
          "marketplace",
          "remove",
          this.#marketplaceName,
        ],
        "marketplace replacement",
      );
    }
    await this.#runRequired(
      [
        "plugin",
        "marketplace",
        "add",
        this.#marketplaceSource,
      ],
      "marketplace registration",
    );
  }

  async #ensurePluginInstalled(): Promise<void> {
    const status = await this.#requireRegistrationStatus();
    if (status.pluginInstalled) {
      return;
    }
    await this.#runRequired(
      [
        "plugin",
        "install",
        this.#pluginReference(),
      ],
      "plugin installation",
    );
  }

  async #assertInstalledPluginVersion(): Promise<void> {
    const status = await this.#requireRegistrationStatus();
    if (!status.pluginInstalled) {
      throw new Error(
        "The ProvenLoop Copilot plugin is not installed.",
      );
    }
    if (status.pluginVersion !== PROVENLOOP_VERSION) {
      throw new Error(
        `Installed ProvenLoop plugin version ${
          status.pluginVersion ?? "unknown"
        } does not match runtime ${PROVENLOOP_VERSION}.`,
      );
    }
  }

  async #ensurePluginEnabled(): Promise<void> {
    const status = await this.#requireRegistrationStatus();
    if (!status.pluginInstalled || status.pluginEnabled) {
      return;
    }
    await this.#runRequired(
      [
        "plugins",
        "enable",
        this.#pluginReference(),
        "--plugin",
      ],
      "plugin enable",
    );
  }

  async #ensurePluginDisabled(): Promise<void> {
    const status = await this.#requireRegistrationStatus();
    if (!status.pluginInstalled || !status.pluginEnabled) {
      return;
    }
    await this.#runRequired(
      [
        "plugins",
        "disable",
        this.#pluginReference(),
        "--plugin",
      ],
      "plugin disable",
    );
  }

  #marketplaceRoot(): string {
    return join(this.#paths.integration, "copilot-marketplace");
  }

  #settingsPath(): string {
    return join(this.#copilotHome, "settings.json");
  }

  #pluginReference(): string {
    return `${COPILOT_PLUGIN_NAME}@${this.#marketplaceName}`;
  }

  async #prepareMarketplaceSource(): Promise<void> {
    if (this.#writeLocalMarketplaceAssets) {
      await this.#writePluginAssets();
    }
  }

  async #writePluginAssets(): Promise<void> {
    const marketplaceRoot = this.#marketplaceRoot();
    const pluginRoot = join(
      marketplaceRoot,
      "plugins",
      COPILOT_PLUGIN_NAME,
    );
    const extensionRoot = join(
      pluginRoot,
      "extensions",
      "event-capture",
    );
    await Promise.all([
      mkdir(join(marketplaceRoot, ".github", "plugin"), {
        recursive: true,
      }),
      mkdir(extensionRoot, {
        recursive: true,
      }),
    ]);
    const marketplace = {
      metadata: {
        description: "ProvenLoop integration marketplace.",
        version: PROVENLOOP_VERSION,
      },
      name: this.#marketplaceName,
      owner: {
        name: "ProvenLoop",
      },
      plugins: [
        {
          description: "Local learning infrastructure for Copilot CLI.",
          name: COPILOT_PLUGIN_NAME,
          source: `./plugins/${COPILOT_PLUGIN_NAME}`,
          version: PROVENLOOP_VERSION,
        },
      ],
    };
    const plugin = {
      description: "Local learning infrastructure for Copilot CLI.",
      extensions: "extensions/",
      mcpServers: ".mcp.json",
      name: COPILOT_PLUGIN_NAME,
      version: PROVENLOOP_VERSION,
    };
    const mcp = {
      mcpServers: {
        provenloop: {
          args: [
            this.#cliBinPath,
            "mcp",
            "serve",
            "--data-root",
            this.#paths.root,
          ],
          command: process.execPath,
          tools: [
            "*",
          ],
          type: "local",
        },
      },
    };
    const extension = [
      'import { joinSession } from "@github/copilot-sdk/extension";',
      `import { runInstalledCopilotExtension } from ${JSON.stringify(
        this.#extensionModuleUrl,
      )};`,
      "",
      "await runInstalledCopilotExtension({",
      `  dataRoot: ${JSON.stringify(this.#paths.root)},`,
      "  joinSession,",
      "});",
      "",
    ].join("\n");
    await Promise.all([
      writeFile(
        join(
          marketplaceRoot,
          ".github",
          "plugin",
          "marketplace.json",
        ),
        `${JSON.stringify(marketplace, null, 2)}\n`,
        "utf8",
      ),
      writeFile(
        join(pluginRoot, "plugin.json"),
        `${JSON.stringify(plugin, null, 2)}\n`,
        "utf8",
      ),
      writeFile(
        join(pluginRoot, ".mcp.json"),
        `${JSON.stringify(mcp, null, 2)}\n`,
        "utf8",
      ),
      writeFile(
        join(extensionRoot, "extension.mjs"),
        extension,
        "utf8",
      ),
    ]);
  }

  #nodeCheck(): AdapterHealthCheck {
    const [
      majorText,
      minorText,
    ] = process.versions.node.split(".");
    const major = Number(majorText);
    const minor = Number(minorText);
    const supported = major > 22 || (major === 22 && minor >= 16);
    return {
      id: "runtime.node",
      message: supported
        ? `Node ${process.versions.node} is supported.`
        : `Node ${process.versions.node} is below the required >=22.16.0.`,
      status: supported ? "pass" : "fail",
    };
  }

  #windowsCheck(): AdapterHealthCheck {
    return {
      id: "runtime.windows",
      message:
        this.#platform === "win32"
          ? "Windows runtime is supported."
          : `Platform ${this.#platform} is not supported by the MVP.`,
      status: this.#platform === "win32" ? "pass" : "fail",
    };
  }

  async #dataRootCheck(): Promise<AdapterHealthCheck> {
    const probePath = join(
      this.#paths.root,
      `.doctor-write-${randomUUID()}`,
    );
    try {
      await access(this.#paths.root, constants.W_OK);
      await writeFile(probePath, "ok", "utf8");
      await rm(probePath, {
        force: true,
      });
      const statistics = await statfs(this.#paths.root);
      const freeBytes = statistics.bavail * statistics.bsize;
      return {
        id: "storage.data-root",
        message:
          `Data root is writable with ${Math.floor(
            freeBytes / (1024 ** 3),
          )} GiB free.`,
        status: freeBytes >= 1024 ** 3 ? "pass" : "warn",
      };
    } catch (error) {
      await rm(probePath, {
        force: true,
      }).catch(() => undefined);
      return {
        id: "storage.data-root",
        message:
          errnoCode(error) === "ENOENT"
            ? "Data root is not initialized; run provenloop install."
            : `Data root check failed: ${sanitizeDiagnostic(error)}`,
        status: errnoCode(error) === "ENOENT" ? "warn" : "fail",
      };
    }
  }

  async #sqliteCheck(): Promise<AdapterHealthCheck> {
    try {
      await access(this.#paths.database);
      const store = new CanonicalSqliteStore(this.#paths.database);
      try {
        const health = store.health();
        const healthy =
          health.quickCheck === "ok" &&
          health.userVersion === DEFAULT_SQLITE_MIGRATIONS.length;
        return {
          id: "storage.sqlite",
          message:
            `SQLite quick_check=${health.quickCheck}, migration=${health.userVersion}.`,
          status: healthy ? "pass" : "fail",
        };
      } finally {
        store.close();
      }
    } catch (error) {
      return {
        id: "storage.sqlite",
        message:
          errnoCode(error) === "ENOENT"
            ? "Canonical SQLite database is not initialized."
            : `SQLite check failed: ${sanitizeDiagnostic(error)}`,
        status: errnoCode(error) === "ENOENT" ? "warn" : "fail",
      };
    }
  }

  async #queueCheck(): Promise<AdapterHealthCheck> {
    try {
      await access(this.#paths.queue);
      const queue = new WindowsCaptureQueue(this.#paths.queue);
      await queue.initialize();
      const items = await queue.list();
      const counts = new Map<string, number>();
      for (const item of items) {
        counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
      }
      const pending =
        (counts.get("pending") ?? 0) +
        (counts.get("claimed") ?? 0) +
        (counts.get("retry") ?? 0);
      const deadLetter = counts.get("dead-letter") ?? 0;
      return {
        id: "capture.queue",
        message:
          `Queue backlog=${pending}, retry=${counts.get("retry") ?? 0}, dead-letter=${deadLetter}.`,
        status: deadLetter > 0 ? "warn" : "pass",
      };
    } catch (error) {
      return {
        id: "capture.queue",
        message:
          errnoCode(error) === "ENOENT"
            ? "Capture queue is not initialized."
            : `Capture queue check failed: ${sanitizeDiagnostic(error)}`,
        status: errnoCode(error) === "ENOENT" ? "warn" : "fail",
      };
    }
  }

  async #workerCheck(): Promise<AdapterHealthCheck> {
    try {
      const leaseName = await resolveWindowsCaptureWorkerLeaseName(
        this.#paths.root,
      );
      const lease = await new WindowsNamedPipeLeaseProvider(
        leaseName,
      ).tryAcquire();
      if (lease === undefined) {
        return {
          id: "worker.lease",
          message: "Capture worker lease is active.",
          status: "pass",
        };
      }
      await lease.release();
      const parsed = JSON.parse(
        await readFile(this.#paths.heartbeat, "utf8"),
      ) as unknown;
      if (
        !isRecord(parsed) ||
        typeof parsed.timestamp !== "string" ||
        Number.isNaN(Date.parse(parsed.timestamp))
      ) {
        throw new Error("Worker heartbeat is malformed.");
      }
      const ageMs =
        this.#now().getTime() - Date.parse(parsed.timestamp);
      return {
        id: "worker.lease",
        message: `Capture worker is idle; last heartbeat was ${Math.max(
          0,
          Math.round(ageMs / 1000),
        )} seconds ago.`,
        status: ageMs <= 120_000 ? "pass" : "warn",
      };
    } catch (error) {
      return {
        id: "worker.lease",
        message:
          errnoCode(error) === "ENOENT"
            ? "Capture worker is idle and has not written a heartbeat."
            : `Worker heartbeat check failed: ${sanitizeDiagnostic(error)}`,
        status: errnoCode(error) === "ENOENT" ? "warn" : "fail",
      };
    }
  }

  #copilotVersionCheck(
    matrix: AdapterCapabilityMatrix,
  ): AdapterHealthCheck {
    return {
      id: "copilot.version",
      message:
        matrix.installedVersion === undefined
          ? "GitHub Copilot CLI is unavailable."
          : matrix.compatibility === "supported"
            ? isVerifiedCopilotCliVersion(matrix.installedVersion)
              ? `GitHub Copilot CLI ${matrix.installedVersion} is verified.`
              : `GitHub Copilot CLI ${matrix.installedVersion} is compatible but has not yet completed ProvenLoop verification.`
            : `GitHub Copilot CLI ${matrix.installedVersion} is incompatible.`,
      status:
        matrix.compatibility === "supported"
          ? matrix.installedVersion !== undefined &&
            isVerifiedCopilotCliVersion(matrix.installedVersion)
            ? "pass"
            : "warn"
          : matrix.compatibility === "unavailable"
            ? "warn"
            : "fail",
    };
  }

  async #syntheticCaptureCheck(): Promise<AdapterHealthCheck> {
    const root = join(
      this.#paths.temporary,
      `doctor-${randomUUID()}`,
    );
    const queueRoot = join(root, "queue");
    const databasePath = join(root, "doctor.db");
    const secret = "ghp_1234567890abcdefghijklmnopqrst";
    let store: CanonicalSqliteStore | undefined;
    try {
      const queue = new WindowsCaptureQueue(queueRoot, {
        idGenerator: () => "doctor-event",
      });
      await queue.initialize();
      const item = await queue.enqueue({
        adapter: "copilot-cli",
        adapterVersion: "1.0.82-0",
        content: {
          message: secret,
        },
        eventType: "prompt.submitted",
        sessionId: "provenloop-doctor",
        sourceEventId: "synthetic-event",
        timestamp: this.#now().toISOString(),
        trust: "user",
      });
      store = new CanonicalSqliteStore(databasePath);
      const result = store.ingestQueueItem(item);
      const record = store.rawEvent(item.envelope.deduplicationKey);
      const persisted = JSON.stringify(record);
      if (
        result.status !== "stored" ||
        record === undefined ||
        persisted.includes(secret)
      ) {
        throw new Error(
          "Synthetic event did not pass queue, redaction, and canonical storage.",
        );
      }
      return {
        id: "capture.synthetic",
        message:
          "Synthetic capture passed queue, redaction, and canonical SQLite.",
        status: "pass",
      };
    } catch (error) {
      return {
        id: "capture.synthetic",
        message: `Synthetic capture failed: ${sanitizeDiagnostic(error)}`,
        status: "fail",
      };
    } finally {
      store?.close();
      await rm(root, {
        force: true,
        recursive: true,
      });
    }
  }

  async #ensureOwnedDataRoot(): Promise<void> {
    const rootPresent = await pathExists(this.#paths.root);
    const markerPresent = await pathExists(this.#paths.rootMarker);
    if (markerPresent) {
      await assertCopilotAdapterDataRoot(this.#paths);
      return;
    }
    if (rootPresent) {
      throw new Error(
        `Refusing to use unowned existing data root ${this.#paths.root}.`,
      );
    } else {
      await mkdir(this.#paths.root, {
        recursive: true,
      });
    }
    await writeFile(
      this.#paths.rootMarker,
      `${JSON.stringify({
        product: DATA_ROOT_MARKER_PRODUCT,
        root: this.#paths.root,
        schemaVersion: 1,
      }, null, 2)}\n`,
      "utf8",
    );
  }

  async #assertOwnedDataRoot(): Promise<void> {
    await assertCopilotAdapterDataRoot(this.#paths);
    if (!await pathExists(this.#paths.adapterState)) {
      throw new Error(
        `ProvenLoop adapter state is missing from ${this.#paths.root}.`,
      );
    }
    await this.#readState();
    this.#assertSafePurgePath();
  }

  #assertSafePurgePath(): void {
    const root = resolve(this.#paths.root);
    const volumeRoot = parsePath(root).root;
    const normalizedRoot = root.toLocaleLowerCase("en-US");
    if (
      normalizedRoot === volumeRoot.toLocaleLowerCase("en-US") ||
      normalizedRoot ===
        resolve(homedir()).toLocaleLowerCase("en-US") ||
      normalizedRoot ===
        resolve(process.cwd()).toLocaleLowerCase("en-US")
    ) {
      throw new Error(`Refusing to purge unsafe data root ${root}.`);
    }
  }
}

export const registerInternalCopilotSession = async (
  dataRoot: string,
  sessionId: string,
): Promise<void> => {
  const normalized = sessionId.trim();
  if (normalized.length === 0) {
    throw new Error("Internal Copilot session ID must be non-empty.");
  }
  const paths = resolveWindowsProvenLoopPaths(dataRoot);
  await assertCopilotAdapterDataRoot(paths);
  const state = await readCopilotAdapterState(
    paths.adapterState,
    new Date(),
  );
  if (!state.installed) {
    throw new Error(
      "Internal Copilot sessions can only be registered after installation.",
    );
  }
  await writeInternalSessionId(paths.internalSessions, normalized);
};

export const unregisterInternalCopilotSession = async (
  dataRoot: string,
  sessionId: string,
): Promise<void> => {
  const paths = resolveWindowsProvenLoopPaths(dataRoot);
  await assertCopilotAdapterDataRoot(paths);
  await removeInternalSessionId(
    paths.internalSessions,
    sessionId.trim(),
  );
};
