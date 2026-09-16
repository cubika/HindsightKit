import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  join,
  resolve,
} from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import { PROVENLOOP_VERSION } from "@provenloop/contracts";
import { LocalMcpToolHandlers } from "@provenloop/cli";

import {
  CopilotCliAdapter,
  readCopilotAdapterState,
  registerInternalCopilotSession,
  runInstalledCopilotExtension,
  setPersistedCapability,
  writeCopilotAdapterState,
  type CommandRunOptions,
  type CommandResult,
  type CommandRunner,
} from "@provenloop/copilot-adapter";
import {
  beginExtensionShutdown,
  isExtensionShutdownRequested,
  isUpgradeMaintenanceActive,
  resolveWindowsCaptureWorkerLeaseName,
  resolveWindowsProvenLoopLeaseName,
  resolveWindowsProvenLoopPaths,
  registerActiveExtension,
  waitForActiveExtensionsToStop,
  WindowsNamedPipeLeaseProvider,
} from "@provenloop/platform-windows";
import {
  CanonicalSqliteStore,
  DEFAULT_SQLITE_MIGRATIONS,
} from "@provenloop/storage-sqlite";

const temporaryDirectories: string[] = [];
const releaseMarketplaceSource = `cubika/ProvenLoop#v${PROVENLOOP_VERSION}`;

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-operational-adapter-"),
  );
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

class FakeCommandRunner implements CommandRunner {
  public readonly calls: string[] = [];
  public readonly options: {
    readonly command: string;
    readonly timeoutMs: number | undefined;
  }[] = [];
  public readonly failures = new Map<string, CommandResult>();
  public marketplaceRegistered = false;
  public marketplaceSource: string | undefined;
  public pluginEnabled = false;
  public pluginInstalled = false;
  public pluginVersion: string = PROVENLOOP_VERSION;
  public providerResult: CommandResult = {
    exitCode: 0,
    stderr: "",
    stdout: "PROVENLOOP_OK\n",
  };
  public registrationProbeFailure = false;
  public unsupportedHelpCommand: string | undefined;
  public version: string | undefined = "1.0.82-0";
  public gitRoot = "C:\\repo\\worktree";

  public run(
    executable: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult> {
    const command = `${executable} ${args.join(" ")}`;
    this.calls.push(command);
    this.options.push({
      command,
      timeoutMs: options?.timeoutMs,
    });
    const failure = this.failures.get(command);
    if (failure !== undefined) {
      this.failures.delete(command);
      return Promise.resolve(failure);
    }
    if (executable === "git") {
      return Promise.resolve(this.#git(args));
    }
    if (args.length === 1 && args[0] === "--version") {
      return Promise.resolve(
        this.version === undefined
          ?           {
            exitCode: 127,
            stderr: "copilot was not found",
            stdout: "",
          }
          : {
              exitCode: 0,
              stderr: "",
              stdout: `GitHub Copilot CLI ${this.version}.\n`,
            },
      );
    }
    if (args.at(-1) === "--help") {
      return Promise.resolve(
        command === this.unsupportedHelpCommand
          ? {
              exitCode: 1,
              stderr: "Unknown command.",
              stdout: "",
            }
          : this.#success(),
      );
    }
    if (args[0] === "--prompt") {
      return Promise.resolve(this.providerResult);
    }
    if (
      args.join(" ") === "plugin marketplace list"
    ) {
      if (this.registrationProbeFailure) {
        return Promise.resolve({
          exitCode: 1,
          stderr: "Copilot is temporarily unavailable.",
          stdout: "",
        });
      }
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: this.marketplaceRegistered
          ? "Registered marketplaces:\n  • provenloop-marketplace " +
            `(GitHub: ${this.marketplaceSource ?? "unknown"})\n`
          : "Registered marketplaces:\n",
      });
    }
    if (args.join(" ") === "plugin list") {
      if (this.registrationProbeFailure) {
        return Promise.resolve({
          exitCode: 1,
          stderr: "Copilot is temporarily unavailable.",
          stdout: "",
        });
      }
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: this.pluginInstalled
          ? `Live Plugins:\n  • provenloop@provenloop-marketplace (v${this.pluginVersion}) (${
              this.pluginEnabled ? "enabled" : "disabled"
            })\n`
          : "Live Plugins:\n",
      });
    }
    if (
      args[0] === "plugin" &&
      args[1] === "marketplace" &&
      args[2] === "add"
    ) {
      this.marketplaceRegistered = true;
      this.marketplaceSource = args[3];
      return Promise.resolve(this.#success());
    }
    if (
      args.join(" ") ===
      "plugin marketplace remove provenloop-marketplace"
    ) {
      this.marketplaceRegistered = false;
      this.marketplaceSource = undefined;
      this.pluginEnabled = false;
      this.pluginInstalled = false;
      return Promise.resolve(this.#success());
    }
    if (
      args.join(" ") ===
      "plugin install provenloop@provenloop-marketplace"
    ) {
      this.pluginInstalled = true;
      this.pluginEnabled = true;
      return Promise.resolve(this.#success());
    }
    if (
      args.join(" ") ===
      "plugin uninstall provenloop@provenloop-marketplace"
    ) {
      this.pluginEnabled = false;
      this.pluginInstalled = false;
      return Promise.resolve(this.#success());
    }
    if (
      args.join(" ") ===
        "plugin marketplace update provenloop-marketplace" ||
      args.join(" ") ===
        "plugin update provenloop@provenloop-marketplace"
    ) {
      return Promise.resolve(this.#success());
    }
    if (
      args.join(" ") ===
      "plugins enable provenloop@provenloop-marketplace --plugin"
    ) {
      this.pluginEnabled = true;
      return Promise.resolve(this.#success());
    }
    if (
      args.join(" ") ===
      "plugins disable provenloop@provenloop-marketplace --plugin"
    ) {
      this.pluginEnabled = false;
      return Promise.resolve(this.#success());
    }
    return Promise.resolve({
      exitCode: 1,
      stderr: `Unexpected command: ${command}`,
      stdout: "",
    });
  }

  #success(): CommandResult {
    return {
      exitCode: 0,
      stderr: "",
      stdout: "",
    };
  }

  #git(args: readonly string[]): CommandResult {
    const operation = args.slice(2).join(" ");
    const values: Readonly<Record<string, string>> = {
      "branch --show-current": "feat/batch5-operational-cli-adapter\n",
      "config --get remote.origin.url":
        "https://example.test/ProvenLoop.git\n",
      "rev-parse --git-common-dir": ".git\n",
      "rev-parse --show-toplevel": `${this.gitRoot}\n`,
      "rev-list --parents -n 1 HEAD":
        "ac758f82454bc729604dbf533d9e3b08460385de 0123456789abcdef0123456789abcdef01234567\n",
    };
    const stdout = values[operation];
    return stdout === undefined
      ? {
          exitCode: 1,
          stderr: "not a git repository",
          stdout: "",
        }
      : {
          exitCode: 0,
          stderr: "",
          stdout,
        };
  }
}

class BlockingVersionCommandRunner extends FakeCommandRunner {
  #releaseVersionCheck: (() => void) | undefined;
  #reportVersionCheckStarted: (() => void) | undefined;
  readonly #versionCheckGate: Promise<void>;
  public readonly versionCheckStarted: Promise<void>;

  public constructor() {
    super();
    this.versionCheckStarted = new Promise<void>((resolve) => {
      this.#reportVersionCheckStarted = resolve;
    });
    this.#versionCheckGate = new Promise<void>((resolve) => {
      this.#releaseVersionCheck = resolve;
    });
  }

  public releaseVersionCheck(): void {
    this.#releaseVersionCheck?.();
  }

  public override async run(
    executable: string,
    args: readonly string[],
    options?: CommandRunOptions,
  ): Promise<CommandResult> {
    if (
      executable === "copilot" &&
      args.length === 1 &&
      args[0] === "--version"
    ) {
      this.#reportVersionCheckStarted?.();
      await this.#versionCheckGate;
    }
    return super.run(executable, args, options);
  }
}

const installPreviousSchema = async (
  root: string,
  databasePath: string,
): Promise<void> => {
  const legacyPath = join(root, "legacy.db");
  const backupPath = join(root, "legacy-backup.db");
  const migrations = DEFAULT_SQLITE_MIGRATIONS.slice(0, -1);
  const legacy = new CanonicalSqliteStore(legacyPath, { migrations });
  await legacy.backupTo(backupPath);
  legacy.close();
  await CanonicalSqliteStore.restoreFromBackup(backupPath, databasePath, { migrations });
  const data = new DatabaseSync(databasePath);
  data.prepare(
    "INSERT INTO metrics(metric_name,metric_value,dimensions_json,recorded_at) VALUES(?,?,?,?)",
  ).run("retained", 1, "{}", "2026-09-01T00:00:00.000Z");
  data.close();
};

describe("Copilot operational adapter", () => {
  it("installs idempotently and preserves JSONC settings", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const copilotHome = join(root, "copilot-home");
    const settingsPath = join(copilotHome, "settings.json");
    await mkdir(copilotHome, {
      recursive: true,
    });
    await writeFile(
      settingsPath,
      `{
  // Preserve this user setting.
  "theme": "dark",
}
`,
      "utf8",
    );
    const runner = new FakeCommandRunner();
    const marketplaceRoot = join(
      dataRoot,
      "integration",
      "copilot-marketplace",
    );
    const adapter = new CopilotCliAdapter({
      cliBinPath: "C:\\tools\\provenloop\\bin.js",
      commandRunner: runner,
      copilotHome,
      dataRoot,
      environment: {},
      extensionModuleUrl:
        "file:///C:/tools/provenloop/extension-entry.js",
      marketplace: {
        name: "provenloop-marketplace",
        source: marketplaceRoot,
        writeLocalAssets: true,
      },
      platform: "win32",
    });

    await expect(adapter.install()).resolves.toMatchObject({
      status: "changed",
    });
    await expect(adapter.install()).resolves.toMatchObject({
      status: "unchanged",
    });
    await expect(adapter.upgrade()).resolves.toMatchObject({
      status: "changed",
    });
    expect(runner.calls).toContain(
      "copilot plugin marketplace update provenloop-marketplace",
    );
    expect(runner.calls).toContain(
      `copilot plugin marketplace add ${marketplaceRoot}`,
    );

    const settings = await readFile(settingsPath, "utf8");
    expect(settings).toContain("// Preserve this user setting.");
    expect(settings).toContain('"experimental": true');
    const plugin = JSON.parse(
      await readFile(
        join(marketplaceRoot, "plugins", "provenloop", "plugin.json"),
        "utf8",
      ),
    ) as Readonly<Record<string, unknown>>;
    const mcp = await readFile(
      join(marketplaceRoot, "plugins", "provenloop", ".mcp.json"),
      "utf8",
    );
    const extension = await readFile(
      join(
        marketplaceRoot,
        "plugins",
        "provenloop",
        "extensions",
        "event-capture",
        "extension.mjs",
      ),
      "utf8",
    );
    expect(plugin).toMatchObject({
      extensions: "extensions/",
      mcpServers: ".mcp.json",
      name: "provenloop",
    });
    expect(mcp).toContain('"mcp"');
    expect(mcp).toContain('"serve"');
    expect(extension).toContain("@github/copilot-sdk/extension");
    expect(extension).toContain(
      "file:///C:/tools/provenloop/extension-entry.js",
    );

    const status = await adapter.status();
    expect(status).toMatchObject({
      installed: true,
      marketplaceRegistered: true,
      pluginEnabled: true,
      pluginInstalled: true,
    });
    expect(status.capabilities.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          availability: "available",
          capability: "capture",
          enabled: true,
        }),
        expect.objectContaining({
          availability: "available",
          capability: "worker",
          enabled: true,
        }),
        expect.objectContaining({
          availability: "available",
          capability: "retrieval",
          enabled: false,
        }),
      ]),
    );
  });

  it("enables, disables, uninstalls, and purges without data loss", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const copilotHome = join(root, "copilot-home");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome,
      dataRoot,
      environment: {},
      platform: "win32",
    });

    await adapter.install();
    const retainedPath = join(dataRoot, "data", "retained.txt");
    await writeFile(retainedPath, "retain", "utf8");

    await expect(adapter.disable("capture")).resolves.toMatchObject({
      status: "changed",
    });
    expect(runner.pluginEnabled).toBe(false);
    await expect(adapter.disable("capture")).resolves.toMatchObject({
      status: "unchanged",
    });
    await expect(adapter.enable("capture")).resolves.toMatchObject({
      status: "changed",
    });
    expect(runner.pluginEnabled).toBe(true);
    await expect(adapter.enable("worker")).resolves.toMatchObject({
      status: "unchanged",
    });
    await expect(adapter.disable("worker")).resolves.toMatchObject({
      status: "changed",
    });

    await expect(
      adapter.uninstall({
        purge: false,
      }),
    ).resolves.toMatchObject({
      status: "changed",
    });
    await expect(access(retainedPath)).resolves.toBeUndefined();
    await expect(
      access(join(dataRoot, "integration")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    const settings = await readFile(
      join(copilotHome, "settings.json"),
      "utf8",
    );
    expect(settings).not.toContain('"experimental": true');

    await writeFile(
      join(copilotHome, "settings.json"),
      `{
  "experimental": true
}
`,
      "utf8",
    );
    await adapter.install();
    await adapter.uninstall({
      purge: false,
    });
    expect(
      await readFile(join(copilotHome, "settings.json"), "utf8"),
    ).toContain('"experimental": true');

    await adapter.install();
    await expect(
      adapter.uninstall({
        purge: true,
      }),
    ).resolves.toMatchObject({
      status: "changed",
    });
    await expect(access(dataRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("supports installation with automatic collection disabled", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });

    await expect(
      adapter.install({
        autoCollect: false,
      }),
    ).resolves.toMatchObject({
      status: "changed",
    });
    expect(runner.calls).toContain(
      "copilot plugin marketplace add " +
        releaseMarketplaceSource,
    );
    const status = await adapter.status();
    expect(status.pluginInstalled).toBe(true);
    expect(
      status.capabilities.capabilities.filter((capability) =>
        [
          "capture",
          "worker",
        ].includes(capability.capability),
      ),
    ).toEqual([
      expect.objectContaining({
        capability: "capture",
        enabled: false,
      }),
      expect.objectContaining({
        capability: "worker",
        enabled: false,
      }),
    ]);
    await expect(adapter.install()).resolves.toMatchObject({
      status: "unchanged",
    });
    const repeated = await adapter.status();
    expect(
      repeated.capabilities.capabilities.filter((capability) =>
        [
          "capture",
          "worker",
        ].includes(capability.capability),
      ),
    ).toEqual([
      expect.objectContaining({
        capability: "capture",
        enabled: false,
      }),
      expect.objectContaining({
        capability: "worker",
        enabled: false,
      }),
    ]);
  });

  it("re-enables retrieval without restarting capture after both were disabled", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });
    await adapter.install();
    await adapter.enable("retrieval");
    await adapter.disable("retrieval");
    await adapter.disable("capture");
    expect(runner.pluginEnabled).toBe(false);
    await adapter.enable("retrieval");
    expect(runner.pluginEnabled).toBe(true);
    const capabilities = (await adapter.capabilities()).capabilities;
    expect(capabilities.find((entry) => entry.capability === "retrieval")
      ?.enabled).toBe(true);
    expect(capabilities.find((entry) => entry.capability === "capture")
      ?.enabled).toBe(false);
    await adapter.disable("retrieval");
    expect(runner.pluginEnabled).toBe(false);
  });

  it("does not report plugin capabilities enabled after an external version mismatch", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner, copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"), environment: {}, platform: "win32",
    });
    await adapter.install();
    await adapter.enable("retrieval");
    runner.pluginVersion = "0.1.0-alpha.0.4";
    const capabilities = (await adapter.capabilities()).capabilities;
    expect(capabilities.find((entry) => entry.capability === "capture")?.enabled).toBe(false);
    expect(capabilities.find((entry) => entry.capability === "retrieval")?.enabled).toBe(false);
  });

  it("serializes concurrent capability changes", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const adapter = new CopilotCliAdapter({
      commandRunner: new FakeCommandRunner(),
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: {},
      platform: "win32",
    });
    await adapter.install();

    await Promise.all([
      adapter.enable("worker"),
      adapter.disable("capture"),
    ]);

    const capabilities = await adapter.capabilities();
    expect(
      capabilities.capabilities.find(
        (capability) => capability.capability === "worker",
      ),
    ).toMatchObject({
      enabled: true,
    });
    expect(
      capabilities.capabilities.find(
        (capability) => capability.capability === "capture",
      ),
    ).toMatchObject({
      enabled: false,
    });
  });

  it("bounds Copilot lifecycle commands", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });

    await adapter.install();
    expect(
      runner.options
        .filter((call) => call.command.startsWith("copilot "))
        .every((call) => call.timeoutMs === 15_000),
    ).toBe(true);
  });

  it("restores the prior integration when plugin replacement fails", async () => {
      const root = await createTemporaryDirectory();
      const dataRoot = join(root, "data-root");
      const locatorPath = join(root, "runtime.json");
      const runner = new FakeCommandRunner();
      const adapter = new CopilotCliAdapter({
        cliBinPath: "C:\\previous-runtime\\bin.js",
        commandRunner: runner,
        copilotHome: join(root, "copilot-home"),
        dataRoot,
        environment: {},
        extensionModuleUrl:
          "file:///C:/previous-runtime/extension-entry.js",
        integrationLocatorPath: locatorPath,
        platform: "win32",
      });
      await adapter.install();
      const previousLocator = await readFile(locatorPath, "utf8");
      runner.marketplaceSource = "cubika/ProvenLoop#v0.1.0-alpha.0.4";
      runner.pluginVersion = "0.1.0-alpha.0.4";
      runner.failures.set(
        `copilot plugin marketplace add ${releaseMarketplaceSource}`,
        {
          exitCode: 1,
          stderr: "network unavailable",
          stdout: "",
        },
      );

      await expect(adapter.upgrade()).rejects.toThrow(
        "prior integration was restored",
      );
      expect(runner.marketplaceRegistered).toBe(true);
      expect(runner.marketplaceSource).toBe(
        "cubika/ProvenLoop#v0.1.0-alpha.0.4",
      );
      expect(runner.pluginInstalled).toBe(true);
      expect(runner.pluginEnabled).toBe(true);
      await expect(readFile(locatorPath, "utf8")).resolves.toBe(
        previousLocator,
      );
  });

  it("snapshots the prior runtime/schema pair and restores it after a migration upgrade fails", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const databasePath = join(dataRoot, "data", "provenloop.db");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner, copilotHome: join(root, "copilot-home"),
      dataRoot, environment: {}, platform: "win32",
    });
    await adapter.install();
    await installPreviousSchema(root, databasePath);
    runner.marketplaceSource = "cubika/ProvenLoop#v0.1.0-alpha.0.4";
    runner.pluginVersion = "0.1.0-alpha.0.4";
    runner.failures.set(
      `copilot plugin marketplace add ${releaseMarketplaceSource}`,
      { exitCode: 1, stderr: "simulated upgrade failure", stdout: "" },
    );
    const inferenceLease = new WindowsNamedPipeLeaseProvider(
      await resolveWindowsProvenLoopLeaseName(dataRoot, "learning-inference"),
    );
    const inferenceObservations: { readonly blocked: boolean; readonly schema: number }[] = [];
    const run = runner.run.bind(runner);
    runner.run = async (executable, args, options) => {
      if (args.slice(0, 3).join(" ") === "plugin marketplace add") {
        const competingLease = await inferenceLease.tryAcquire();
        try {
          inferenceObservations.push({
            blocked: competingLease === undefined,
            schema: CanonicalSqliteStore.databaseVersion(databasePath),
          });
        } finally {
          await competingLease?.release();
        }
      }
      return run(executable, args, options);
    };
    await expect(adapter.upgrade()).rejects.toThrow("registration and schema");
    expect(inferenceObservations).toEqual([
      { blocked: true, schema: DEFAULT_SQLITE_MIGRATIONS.length },
      { blocked: true, schema: DEFAULT_SQLITE_MIGRATIONS.length - 1 },
    ]);
    const releasedInferenceLease = await inferenceLease.tryAcquire();
    try {
      expect(releasedInferenceLease).toBeDefined();
    } finally {
      await releasedInferenceLease?.release();
    }
    expect(CanonicalSqliteStore.databaseVersion(databasePath)).toBe(
      DEFAULT_SQLITE_MIGRATIONS.length - 1,
    );
    const backupRoot = join(dataRoot, "data", "backups");
    const snapshot = (await readdir(backupRoot)).find((name) => name.endsWith(".db"));
    if (snapshot === undefined) throw new Error("Expected the prior schema snapshot.");
    expect(await CanonicalSqliteStore.verifyBackup(join(backupRoot, snapshot)))
      .toMatchObject({
        runtimeVersion: "0.1.0-alpha.0.4",
        schemaVersion: DEFAULT_SQLITE_MIGRATIONS.length - 1,
      });
    const data = new DatabaseSync(databasePath);
    try {
      expect(data.prepare("SELECT metric_name FROM metrics").all())
        .toEqual([{ metric_name: "retained" }]);
    } finally {
      data.close();
    }
  });

  it("preserves new canonical writes instead of rolling back a failed schema upgrade", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const databasePath = join(dataRoot, "data", "provenloop.db");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner, copilotHome: join(root, "copilot-home"),
      dataRoot, environment: {}, platform: "win32",
    });
    await adapter.install();
    await installPreviousSchema(root, databasePath);
    runner.marketplaceSource = "cubika/ProvenLoop#v0.1.0-alpha.0.4";
    runner.pluginVersion = "0.1.0-alpha.0.4";
    const run = runner.run.bind(runner);
    runner.run = async (executable, args, options) => {
      if (args.join(" ") === `plugin marketplace add ${releaseMarketplaceSource}`) {
        const data = new DatabaseSync(databasePath);
        try {
          data.prepare(
            "INSERT INTO metrics(metric_name,metric_value,dimensions_json,recorded_at) VALUES(?,?,?,?)",
          ).run("new-write", 2, "{}", "2026-09-01T00:01:00.000Z");
        } finally {
          data.close();
        }
        return { exitCode: 1, stderr: "simulated replacement failure", stdout: "" };
      }
      return run(executable, args, options);
    };
    await expect(adapter.upgrade()).rejects.toThrow("New canonical writes were preserved");
    expect(CanonicalSqliteStore.databaseVersion(databasePath))
      .toBe(DEFAULT_SQLITE_MIGRATIONS.length);
    const data = new DatabaseSync(databasePath);
    try {
      expect(data.prepare("SELECT metric_name FROM metrics ORDER BY metric_name").all())
        .toEqual([{ metric_name: "new-write" }, { metric_name: "retained" }]);
    } finally {
      data.close();
    }
    expect((await adapter.capabilities()).capabilities.every((capability) =>
      !capability.enabled,
    )).toBe(true);
    const reviewError = "Upgrade recovery requires review; canonical data changed after migration.";
    const statePath = resolveWindowsProvenLoopPaths(dataRoot).adapterState;
    expect((await readCopilotAdapterState(statePath, new Date())).capabilities.capture.lastError)
      .toBe(reviewError);
    runner.run = run;
    runner.pluginVersion = PROVENLOOP_VERSION;
    await expect(adapter.upgrade()).resolves.toMatchObject({ status: "changed" });
    expect((await readCopilotAdapterState(statePath, new Date())).capabilities.capture)
      .toEqual({ enabled: false, lastError: reviewError });
  });

  it("times out before migration and plugin replacement while learning is active, then retries safely", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const databasePath = join(dataRoot, "data", "provenloop.db");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner, copilotHome: join(root, "copilot-home"),
      dataRoot, environment: {}, platform: "win32", upgradeDrainTimeoutMs: 100,
    });
    await adapter.install();
    await installPreviousSchema(root, databasePath);
    const originalFingerprint = CanonicalSqliteStore.databaseFingerprint(databasePath);
    const commandBoundary = runner.calls.length;
    const inferenceLease = await new WindowsNamedPipeLeaseProvider(
      await resolveWindowsProvenLoopLeaseName(dataRoot, "learning-inference"),
    ).tryAcquire();
    try {
      expect(inferenceLease).toBeDefined();
      await expect(adapter.upgrade()).rejects.toThrow(/learning|inference/iu);
      expect(CanonicalSqliteStore.databaseVersion(databasePath))
        .toBe(DEFAULT_SQLITE_MIGRATIONS.length - 1);
      expect(CanonicalSqliteStore.databaseFingerprint(databasePath)).toBe(originalFingerprint);
      expect(runner.calls.slice(commandBoundary).filter((command) =>
        !command.endsWith(" --help") &&
        /^copilot (?:plugin (?:uninstall|install|update)|plugin marketplace (?:add|remove|update)|plugins (?:enable|disable))/u.test(command),
      )).toEqual([]);
      expect(await isExtensionShutdownRequested(dataRoot)).toBe(false);
      expect(await isUpgradeMaintenanceActive(dataRoot)).toBe(false);
    } finally {
      await inferenceLease?.release();
    }
    await expect(adapter.upgrade()).resolves.toMatchObject({ status: "changed" });
    expect(CanonicalSqliteStore.databaseVersion(databasePath)).toBe(DEFAULT_SQLITE_MIGRATIONS.length);
    const data = new DatabaseSync(databasePath);
    try {
      expect(data.prepare("SELECT metric_name FROM metrics").all())
        .toEqual([{ metric_name: "retained" }]);
    } finally {
      data.close();
    }
  });

  it("refuses an upgrade before mutation when inference scratch ownership is unknown", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const databasePath = join(dataRoot, "data", "provenloop.db");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner, copilotHome: join(root, "copilot-home"),
      dataRoot, environment: {}, platform: "win32",
    });
    await adapter.install();
    await installPreviousSchema(root, databasePath);
    const scratch = join(dataRoot, "temp", "learning-invalid");
    await mkdir(scratch, { recursive: true });
    const ownershipPath = join(scratch, ".provenloop-inference.json");
    await writeFile(ownershipPath, "{}", "utf8");
    const originalFingerprint = CanonicalSqliteStore.databaseFingerprint(databasePath);
    const commandBoundary = runner.calls.length;
    await expect(adapter.upgrade()).rejects.toThrow(/scratch ownership/iu);
    expect(CanonicalSqliteStore.databaseVersion(databasePath))
      .toBe(DEFAULT_SQLITE_MIGRATIONS.length - 1);
    expect(CanonicalSqliteStore.databaseFingerprint(databasePath)).toBe(originalFingerprint);
    expect(runner.calls.slice(commandBoundary).filter((command) =>
      !command.endsWith(" --help") &&
      /^copilot (?:plugin (?:uninstall|install|update)|plugin marketplace (?:add|remove|update)|plugins (?:enable|disable))/u.test(command),
    )).toEqual([]);
    expect(await readFile(ownershipPath, "utf8")).toBe("{}");
    expect(await isExtensionShutdownRequested(dataRoot)).toBe(false);
    const released = await new WindowsNamedPipeLeaseProvider(
      await resolveWindowsProvenLoopLeaseName(dataRoot, "learning-inference"),
    ).tryAcquire();
    try {
      expect(released).toBeDefined();
    } finally {
      await released?.release();
    }
  });
  it("stops owned plugin processes before file replacement and leaves migration untouched if cleanup fails", async () => {
    const root = await createTemporaryDirectory(); const dataRoot = join(root, "data-root");
    const databasePath = join(dataRoot, "data", "provenloop.db"); const runner = new FakeCommandRunner();
    let refuse = true; let cleaned = false;
    const adapter = new CopilotCliAdapter({ commandRunner: runner, copilotHome: join(root, "copilot-home"), dataRoot, environment: {}, platform: "win32",
      stopOwnedPluginProcesses: async () => {
        expect(await isExtensionShutdownRequested(dataRoot)).toBe(true);
        if (refuse) throw new Error("Cannot verify owned plugin process identity");
        cleaned = true;
      } });
    await adapter.install(); await installPreviousSchema(root, databasePath);
    const before = CanonicalSqliteStore.databaseFingerprint(databasePath);
    await expect(adapter.upgrade()).rejects.toThrow("Cannot verify owned plugin process");
    expect(CanonicalSqliteStore.databaseFingerprint(databasePath)).toBe(before);
    expect(runner.pluginInstalled).toBe(true);
    refuse = false; const run = runner.run.bind(runner);
    runner.run = async (exe, args, options) => {
      if (args.slice(0, 2).join(" ") === "plugin uninstall") expect(cleaned).toBe(true);
      return run(exe, args, options);
    };
    expect(await adapter.upgrade()).toMatchObject({ status: "changed" });
  });
  it("lets participating processes drain before stopping legacy helpers", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const runner = new FakeCommandRunner();
    let cleaned = false;
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: {},
      platform: "win32",
      stopOwnedPluginProcesses: async () => { cleaned = true; },
    });
    await adapter.install();
    const active = await registerActiveExtension(dataRoot, "draining-runtime");
    const upgrading = adapter.upgrade();
    try {
      await expect.poll(() => isExtensionShutdownRequested(dataRoot)).toBe(true);
      expect(cleaned).toBe(false);
    } finally {
      await active.release();
    }
    await expect(upgrading).resolves.toMatchObject({ status: "changed" });
    expect(cleaned).toBe(true);
  });

  it.each([
    "Access is denied. (os error 5)",
    "The process cannot access the file because it is being used by another process. (os error 32)",
  ])("refreshes verified plugin files on %s without retrying uninstall", async (stderr) => {
    const root = await createTemporaryDirectory(); const runner = new FakeCommandRunner();
    let refreshed = false; let rolledBack = false;
    const adapter = new CopilotCliAdapter({ commandRunner: runner, copilotHome: join(root, "copilot-home"), dataRoot: join(root, "data"), environment: {}, platform: "win32",
      refreshLockedPlugin: async () => { refreshed = true; runner.pluginVersion = PROVENLOOP_VERSION; runner.marketplaceSource = releaseMarketplaceSource; return { rollback: async () => { rolledBack = true; } }; } });
    await adapter.install(); runner.pluginVersion = "0.1.0-alpha.0.10";
    runner.failures.set("copilot plugin uninstall provenloop@provenloop-marketplace", { exitCode: 1, stdout: "", stderr });
    const result = await adapter.upgrade();
    expect(result.status).toBe("changed"); expect(refreshed).toBe(true); expect(rolledBack).toBe(false);
    expect(runner.pluginInstalled).toBe(true); expect(runner.pluginVersion).toBe(PROVENLOOP_VERSION);
  });
  it("rolls back an in-place refresh if later plugin verification fails without another uninstall", async () => {
    const root = await createTemporaryDirectory(); const runner = new FakeCommandRunner();
    let rolledBack = false;
    const adapter = new CopilotCliAdapter({ commandRunner: runner, copilotHome: join(root, "copilot-home"), dataRoot: join(root, "data"), environment: {}, platform: "win32",
      refreshLockedPlugin: async () => ({ rollback: async () => { rolledBack = true; } }) });
    await adapter.install(); runner.pluginVersion = "0.1.0-alpha.0.10";
    runner.failures.set("copilot plugin uninstall provenloop@provenloop-marketplace", { exitCode: 1, stdout: "", stderr: "Access is denied. (os error 5)" });
    const start = runner.calls.length;
    await expect(adapter.upgrade()).rejects.toThrow("prior integration was restored");
    expect(rolledBack).toBe(true);
    expect(runner.calls.slice(start).filter((call) => call === "copilot plugin uninstall provenloop@provenloop-marketplace")).toHaveLength(1);
  });

  it("does not repeat uninstall when locked-file recovery cannot prove ownership", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
      refreshLockedPlugin: async () => {
        throw new Error("Cannot safely refresh an unverified plugin registration.");
      },
    });
    await adapter.install();
    runner.failures.set("copilot plugin uninstall provenloop@provenloop-marketplace", {
      exitCode: 1, stdout: "", stderr: "Windows sharing violation (os error 32)",
    });
    const start = runner.calls.length;
    await expect(adapter.upgrade()).rejects.toThrow("Cannot safely refresh");
    expect(runner.calls.slice(start).filter((call) =>
      call === "copilot plugin uninstall provenloop@provenloop-marketplace",
    )).toHaveLength(1);
    expect(runner.pluginInstalled).toBe(true);
  });

  it.each([false, true])("preserves learning opt-out through recovery, with legacy acknowledgement: %s", async (legacyAcknowledgement) => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: {},
      platform: "win32",
    });
    await adapter.install();
    const paths = resolveWindowsProvenLoopPaths(dataRoot);
    const now = new Date();
    let state = await readCopilotAdapterState(paths.adapterState, now);
    state = {
      ...state,
      automaticLearning: {
        ...(legacyAcknowledgement ? { consentedAt: now.toISOString(), disclosureVersion: 1 as const } : {}),
        enabled: false, notificationsEnabled: false,
      },
    };
    for (const capability of ["retrieval", "outcome_learning"] as const) {
      state = setPersistedCapability(state, capability, {
        enabled: false,
        lastError: "Schema upgrade recovery is incomplete; review the retained snapshot before resuming.",
      }, now);
    }
    state = setPersistedCapability(state, "external_research", {
      enabled: false,
      lastError: "An unrelated error still needs review.",
    }, now);
    await writeCopilotAdapterState(paths.adapterState, state);
    runner.failures.set("copilot plugin marketplace update provenloop-marketplace", {
      exitCode: 1, stdout: "", stderr: "Network unavailable",
    });
    await expect(adapter.upgrade()).rejects.toThrow("Network unavailable");
    expect(await readCopilotAdapterState(paths.adapterState, now)).toEqual(state);

    await expect(adapter.install()).resolves.toMatchObject({ status: "changed" });
    const recovered = await readCopilotAdapterState(paths.adapterState, now);
    expect(recovered.capabilities.retrieval).toEqual({ enabled: false });
    expect(recovered.capabilities.outcome_learning).toEqual({ enabled: false });
    expect(recovered.capabilities.capture.enabled).toBe(state.capabilities.capture.enabled);
    expect(recovered.capabilities.external_research).toEqual(state.capabilities.external_research);
    expect(recovered.automaticLearning).toEqual(state.automaticLearning);
  });

  it.each(["capture-worker", "observations"] as const)(
    "times out safely while %s holds its maintenance lease",
    async (purpose) => {
      const root = await createTemporaryDirectory();
      const dataRoot = join(root, "data-root");
      const runner = new FakeCommandRunner();
      const adapter = new CopilotCliAdapter({
        commandRunner: runner, copilotHome: join(root, "copilot-home"),
        dataRoot, environment: {}, platform: "win32", upgradeDrainTimeoutMs: 100,
      });
      await adapter.install();
      const lease = await new WindowsNamedPipeLeaseProvider(
        purpose === "capture-worker"
          ? await resolveWindowsCaptureWorkerLeaseName(dataRoot)
          : await resolveWindowsProvenLoopLeaseName(dataRoot, purpose),
      ).tryAcquire();
      try {
        await expect(adapter.upgrade()).rejects.toThrow(/timed out/iu);
        expect(await isUpgradeMaintenanceActive(dataRoot)).toBe(false);
        expect(await isExtensionShutdownRequested(dataRoot)).toBe(false);
      } finally {
        await lease?.release();
      }
      await expect(adapter.upgrade()).resolves.toMatchObject({ status: "changed" });
    },
  );

  it("waits for an active MCP database lease before stopping Sessions and migrating", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const databasePath = join(dataRoot, "data", "provenloop.db");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner, copilotHome: join(root, "copilot-home"),
      dataRoot, environment: {}, platform: "win32", upgradeDrainTimeoutMs: 2_000,
    });
    await adapter.install();
    await installPreviousSchema(root, databasePath);
    const session = await registerActiveExtension(dataRoot, "open-upgrade-session");
    const request = await new WindowsNamedPipeLeaseProvider(
      await resolveWindowsProvenLoopLeaseName(dataRoot, "knowledge-projection"),
    ).tryAcquire();
    expect(request).toBeDefined();
    let finished = false;
    const upgrading = adapter.upgrade().finally(() => { finished = true; });
    void upgrading.catch(() => undefined);
    try {
      await expect.poll(() => isUpgradeMaintenanceActive(dataRoot)).toBe(true);
      expect(finished).toBe(false);
      expect(await isExtensionShutdownRequested(dataRoot)).toBe(false);
      expect(CanonicalSqliteStore.databaseVersion(databasePath))
        .toBe(DEFAULT_SQLITE_MIGRATIONS.length - 1);
      await request?.release();
      await expect.poll(() => isExtensionShutdownRequested(dataRoot)).toBe(true);
      await session.release();
      await expect(upgrading).resolves.toMatchObject({
        status: "changed", message: expect.stringMatching(/restart.*sessions/iu),
      });
      expect(CanonicalSqliteStore.databaseVersion(databasePath)).toBe(DEFAULT_SQLITE_MIGRATIONS.length);
      expect(() => new CanonicalSqliteStore(databasePath, { migrations: DEFAULT_SQLITE_MIGRATIONS.slice(0, -1) }))
        .toThrow("newer than supported");
      expect(await isUpgradeMaintenanceActive(dataRoot)).toBe(false);
    } finally {
      await request?.release();
      await session.release();
      await upgrading.catch(() => undefined);
    }
  });

  it("removes admission pause after timeout and leaves the existing Session and MCP handler usable", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner, copilotHome: join(root, "copilot-home"),
      dataRoot, environment: {}, platform: "win32", upgradeDrainTimeoutMs: 100,
    });
    await adapter.install();
    const paths = resolveWindowsProvenLoopPaths(dataRoot);
    const stateBefore = await readFile(paths.adapterState, "utf8");
    const session = await registerActiveExtension(dataRoot, "timeout-upgrade-session");
    const handlers = new LocalMcpToolHandlers({ cwd: root, dataRoot, now: () => new Date() });
    const request = await new WindowsNamedPipeLeaseProvider(
      await resolveWindowsProvenLoopLeaseName(dataRoot, "knowledge-projection"),
    ).tryAcquire();
    expect(request).toBeDefined();
    try {
      await expect(adapter.upgrade()).rejects.toThrow(/timed out/iu);
      expect(await isUpgradeMaintenanceActive(dataRoot)).toBe(false);
      expect(await isExtensionShutdownRequested(dataRoot)).toBe(false);
      expect(await readFile(paths.adapterState, "utf8")).toBe(stateBefore);
      await expect(registerActiveExtension(dataRoot, "timeout-upgrade-session"))
        .rejects.toThrow("already active");
      await request?.release();
      await expect(handlers.context({ cwd: root, prompt: "Continue the same task.", sessionId: "timeout-upgrade-session", tokenBudget: 200 }))
        .resolves.toMatchObject({ status: "degraded", statusDetail: "Retrieval capability is disabled." });
      const store = new CanonicalSqliteStore(paths.database);
      try { expect(store.contextUseRecords("timeout-upgrade-session")).toHaveLength(1); }
      finally { store.close(); }
    } finally {
      await request?.release();
      await session.release();
    }
  });

  it("validates managed Copilot settings before uninstalling", async () => {
      const root = await createTemporaryDirectory();
      const copilotHome = join(root, "copilot-home");
      const runner = new FakeCommandRunner();
      const adapter = new CopilotCliAdapter({
        commandRunner: runner,
        copilotHome,
        dataRoot: join(root, "data-root"),
        environment: {},
        platform: "win32",
      });
      await adapter.install();
      await writeFile(
        join(copilotHome, "settings.json"),
        "{ invalid",
        "utf8",
      );
      const callsBefore = runner.calls.length;

      await expect(
        adapter.uninstall({
          purge: false,
        }),
      ).rejects.toThrow("Copilot settings are malformed");
      expect(runner.calls).toHaveLength(callsBefore);
      expect(runner.marketplaceRegistered).toBe(true);
      expect(runner.pluginInstalled).toBe(true);
  });

  it("waits for every active Extension to acknowledge a purge", async () => {
      const root = await createTemporaryDirectory();
      const registration = await registerActiveExtension(
        root,
        "extension-session",
      );
      const shutdown = await beginExtensionShutdown(root);
      expect(await isExtensionShutdownRequested(root)).toBe(true);
      const waiting = waitForActiveExtensionsToStop(root, 1_000);

      await registration.release();
      await expect(waiting).resolves.toBeUndefined();
      await shutdown.cancel();
  });

  it("does not recreate a data root purged during Extension startup", async () => {
      const root = await createTemporaryDirectory();
      const marker = join(root, ".provenloop-root.json");
      await writeFile(marker, "{}\n", "utf8");
      const shutdown = await beginExtensionShutdown(root);
      const starting = registerActiveExtension(
        root,
        "starting-during-purge",
        {
          assertDataRoot: () => access(marker),
        },
      );

      await rm(root, {
        force: true,
        recursive: true,
      });
      await shutdown.cancel();
      await expect(starting).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(root)).rejects.toMatchObject({
        code: "ENOENT",
      });
  });

  it("refuses to purge while the capture worker lease is active", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const adapter = new CopilotCliAdapter({
      commandRunner: new FakeCommandRunner(),
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: {},
      platform: "win32",
    });
    await adapter.install();
    await adapter.enable("worker");
    const leaseName =
      await resolveWindowsCaptureWorkerLeaseName(dataRoot);
    const lease = await new WindowsNamedPipeLeaseProvider(
      leaseName,
    ).tryAcquire();
    if (lease === undefined) {
      throw new Error("Expected to acquire the worker lease.");
    }
    try {
      await expect(
        adapter.uninstall({
          purge: true,
        }),
      ).rejects.toThrow(
        "Cannot purge while the capture worker is active.",
      );
      await expect(access(dataRoot)).resolves.toBeUndefined();
    } finally {
      await lease.release();
    }

    await expect(
      adapter.uninstall({
        purge: true,
      }),
    ).resolves.toMatchObject({
      status: "changed",
    });
    await expect(access(dataRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    {
      purpose: "knowledge-projection",
      error: "Cannot purge while retrieval, deletion, or Knowledge projection is active.",
    },
    {
      purpose: "observations",
      error: "Cannot purge while an observation collector is active.",
    },
  ] as const)("refuses to purge while $purpose holds its lease", async ({ purpose, error }) => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const adapter = new CopilotCliAdapter({
      commandRunner: new FakeCommandRunner(),
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: { LOCALAPPDATA: join(root, "local-app-data") },
      platform: "win32",
    });

    await adapter.install();
    const provider = new WindowsNamedPipeLeaseProvider(
      await resolveWindowsProvenLoopLeaseName(
        dataRoot,
        purpose,
      ),
    );
    const lease = await provider.tryAcquire();
    if (lease === undefined) {
      throw new Error(
        `Expected to acquire the ${purpose} lease.`,
      );
    }
    try {
      await expect(
        adapter.uninstall({
          purge: true,
        }),
      ).rejects.toThrow(
        error,
      );
      await expect(access(dataRoot)).resolves.toBeUndefined();
      await expect(adapter.status()).resolves.toMatchObject({
        installed: true,
        marketplaceRegistered: true,
        pluginEnabled: true,
        pluginInstalled: true,
      });
    } finally {
      await lease.release();
    }

    await expect(
      adapter.uninstall({
        purge: true,
      }),
    ).resolves.toMatchObject({
      status: "changed",
    });
    await expect(access(dataRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the Extension registered until background shutdown has finished", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const environment = {
      LOCALAPPDATA: join(root, "local-app-data"),
      SESSION_ID: "learning-maintenance-session",
    };
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner, copilotHome: join(root, "copilot-home"),
      dataRoot, environment, platform: "win32",
    });
    await adapter.install();
    let finishStopping: (() => void) | undefined;
    let reportStopping: (() => void) | undefined;
    const stoppingStarted = new Promise<void>((resolveStarted) => { reportStopping = resolveStarted; });
    const stopping = new Promise<void>((resolveStopping) => { finishStopping = resolveStopping; });
    let stopped = false;
    const result = await runInstalledCopilotExtension({
      commandRunner: runner, copilotHome: join(root, "copilot-home"),
      dataRoot, environment, signalSource: { once: () => undefined },
      joinSession: async () => ({ on: () => undefined }),
      onStopping: () => { reportStopping?.(); return stopping; },
      onStopped: () => { stopped = true; },
    });
    expect(result).toMatchObject({ status: "started" });
    const shutdown = await beginExtensionShutdown(dataRoot);
    try {
      await stoppingStarted;
      await expect(waitForActiveExtensionsToStop(dataRoot, 50)).rejects.toThrow();
      expect(stopped).toBe(false);
      finishStopping?.();
      await expect(waitForActiveExtensionsToStop(dataRoot, 2_000)).resolves.toBeUndefined();
      expect(stopped).toBe(true);
    } finally {
      finishStopping?.();
      await waitForActiveExtensionsToStop(dataRoot, 2_000);
      await shutdown.cancel();
    }
  });

  it("stops active Extension capture before purging the data root", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const localAppData = join(root, "local-app-data");
    const environment = {
      LOCALAPPDATA: localAppData,
      SESSION_ID: "active-purge-session",
    };
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment,
      platform: "win32",
    });
    await adapter.install();
    await expect(
      runInstalledCopilotExtension({
        commandRunner: runner,
        copilotHome: join(root, "copilot-home"),
        dataRoot,
        environment,
        joinSession: async () => ({
          on: () => undefined,
        }),
      }),
    ).resolves.toMatchObject({
      status: "started",
    });

    await adapter.uninstall({
      purge: true,
    });
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, 1_200);
    });

    await expect(access(dataRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(
        join(
          localAppData,
          "ProvenLoopIntegration",
          "runtime.json",
        ),
      ),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("registers an Extension before its Copilot version check", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const environment = {
      LOCALAPPDATA: join(root, "local-app-data"),
      SESSION_ID: "starting-extension-session",
    };
    const adapter = new CopilotCliAdapter({
      commandRunner: new FakeCommandRunner(),
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment,
      platform: "win32",
    });
    await adapter.install();
    const runner = new BlockingVersionCommandRunner();
    const starting = runInstalledCopilotExtension({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment,
      joinSession: async () => ({
        on: () => undefined,
      }),
    });

    await runner.versionCheckStarted;
    expect(
      await readdir(
        join(dataRoot, "data", "extension-sessions"),
      ),
    ).toHaveLength(1);

    runner.releaseVersionCheck();
    await expect(starting).resolves.toMatchObject({
      status: "started",
    });
    await expect(
      adapter.uninstall({
        purge: true,
      }),
    ).resolves.toMatchObject({
      status: "changed",
    });
  });

  it("reports unsupported Copilot versions without mutating Copilot", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    runner.version = "1.0.70-0";
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });

    await expect(adapter.install()).resolves.toMatchObject({
      status: "incompatible",
    });
    expect(
      runner.calls.some((call) => call.includes("plugin install")),
    ).toBe(false);
    const matrix = await adapter.capabilities();
    expect(matrix).toMatchObject({
      compatibility: "incompatible",
      installedVersion: "1.0.70-0",
    });
    expect(
      matrix.capabilities.find(
        (capability) => capability.capability === "capture",
      ),
    ).toMatchObject({
      availability: "incompatible",
      enabled: false,
    });
  });

  it("installs with newer compatible Copilot versions", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    runner.version = "1.0.83-4";
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });

    await expect(adapter.install()).resolves.toMatchObject({
      status: "changed",
    });
    await expect(adapter.capabilities()).resolves.toMatchObject({
      compatibility: "supported",
      installedVersion: "1.0.83-4",
      capture: {
        adapterVersion: "1.0.83-4",
      },
    });
    await expect(adapter.doctor({
      online: true,
    })).resolves.toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({
          id: "copilot.version",
          message: "GitHub Copilot CLI 1.0.83-4 is verified.",
          status: "pass",
        }),
      ]),
    });
    runner.version = "1.1.0";
    await expect(adapter.doctor({
      online: true,
    })).resolves.toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({
          id: "copilot.version",
          message:
            "GitHub Copilot CLI 1.1.0 is compatible but has not yet completed ProvenLoop verification.",
          status: "warn",
        }),
      ]),
    });
  });

  it("stops before changing Copilot configuration when required commands are unavailable", async () => {
    const root = await createTemporaryDirectory();
    const copilotHome = join(root, "copilot-home");
    const runner = new FakeCommandRunner();
    runner.unsupportedHelpCommand = "copilot plugins enable --help";
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome,
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });

    await expect(adapter.install()).rejects.toThrow(
      "Copilot Plugin enablement support failed: Unknown command.",
    );
    expect(
      runner.calls.some((call) =>
        call.startsWith("copilot plugin marketplace add "),
      ),
    ).toBe(false);
    await expect(access(join(copilotHome, "settings.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("resolves Git identity and suppresses registered internal sessions", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: {},
      platform: "win32",
    });
    await adapter.install();
    await registerInternalCopilotSession(dataRoot, "session-internal");

    await expect(
      adapter.resolveSession({
        adapterVersion: "1.0.82-0",
        cwd: runner.gitRoot,
        environment: {},
        sessionId: "session-internal",
      }),
    ).resolves.toEqual({
      branch: "feat/batch5-operational-cli-adapter",
      commitSha: "ac758f82454bc729604dbf533d9e3b08460385de",
      commitParents: [
        "0123456789abcdef0123456789abcdef01234567",
      ],
      internalSession: true,
      repositoryId: resolve(runner.gitRoot, ".git"),
      repositoryRemote: "https://example.test/ProvenLoop.git",
      repositoryRoot: runner.gitRoot,
      sessionId: "session-internal",
      worktreePath: runner.gitRoot,
    });
  });

  it("keeps the installed Extension fail-open when capture is disabled", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: {},
      platform: "win32",
    });
    await adapter.install();
    await adapter.disable("capture");
    let joined = false;

    await expect(
      runInstalledCopilotExtension({
        dataRoot,
        environment: {
          SESSION_ID: "session-1",
        },
        joinSession: async () => {
          joined = true;
          throw new Error("joinSession should not be called");
        },
      }),
    ).resolves.toEqual({
      status: "disabled",
    });
    expect(joined).toBe(false);
  });

  it("rechecks the live Copilot version before Extension capture starts", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const copilotHome = join(root, "copilot-home");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome,
      dataRoot,
      environment: {},
      platform: "win32",
    });
    await adapter.install();
    runner.version = "1.0.70-0";
    let joined = false;

    await expect(
      runInstalledCopilotExtension({
        commandRunner: runner,
        copilotHome,
        dataRoot,
        environment: {
          SESSION_ID: "session-1",
        },
        joinSession: async () => {
          joined = true;
          throw new Error("joinSession should not be called");
        },
      }),
    ).resolves.toEqual({
      status: "incompatible",
    });
    expect(joined).toBe(false);
  });

  it("reports external plugin deactivation in effective capabilities", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });

    await adapter.install();
    runner.pluginEnabled = false;

    const status = await adapter.status();
    expect(
      status.capabilities.capabilities.find(
        (capability) => capability.capability === "capture",
      ),
    ).toMatchObject({
      enabled: false,
      lastError: "The ProvenLoop Copilot plugin is disabled.",
    });
    await expect(adapter.enable("capture")).resolves.toMatchObject({
      status: "changed",
    });
    expect(runner.pluginEnabled).toBe(true);
  });

  it("fails closed when the marketplace plugin version differs from the runtime", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    runner.marketplaceRegistered = true;
    runner.pluginEnabled = true;
    runner.pluginInstalled = true;
    runner.pluginVersion = "0.1.0-alpha.1";
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });

    await expect(adapter.install()).rejects.toThrow(
      `does not match runtime ${PROVENLOOP_VERSION}`,
    );
    await expect(adapter.status()).resolves.toMatchObject({
      installed: false,
      pluginVersion: "0.1.0-alpha.1",
    });
  });

  it("replaces a same-name marketplace from an untrusted source", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    runner.marketplaceRegistered = true;
    runner.marketplaceSource = "attacker/untrusted";
    runner.pluginEnabled = true;
    runner.pluginInstalled = true;
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });

    await expect(adapter.install()).resolves.toMatchObject({
      status: "changed",
    });
    expect(runner.calls).toEqual(
      expect.arrayContaining([
        "copilot plugin uninstall provenloop@provenloop-marketplace",
        "copilot plugin marketplace remove provenloop-marketplace",
        "copilot plugin marketplace add " +
          releaseMarketplaceSource,
      ]),
    );
  });

  it("reads the pinned marketplace ref from Copilot settings", async () => {
    const root = await createTemporaryDirectory();
    const copilotHome = join(root, "copilot-home");
    await mkdir(copilotHome, {
      recursive: true,
    });
    await writeFile(
      join(copilotHome, "settings.json"),
      `${JSON.stringify({
        extraKnownMarketplaces: {
          "provenloop-marketplace": {
            source: {
              ref: `v${PROVENLOOP_VERSION}`,
              repo: "cubika/ProvenLoop",
              source: "github",
            },
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const runner = new FakeCommandRunner();
    runner.marketplaceRegistered = true;
    runner.marketplaceSource = "cubika/ProvenLoop";
    runner.pluginEnabled = true;
    runner.pluginInstalled = true;
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome,
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });

    await expect(adapter.install()).resolves.toMatchObject({
      status: "changed",
    });
    expect(runner.calls).not.toContain(
      "copilot plugin marketplace remove provenloop-marketplace",
    );
  });

  it("does not report uninstall success when registration probes fail", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: {},
      platform: "win32",
    });
    await adapter.install();
    runner.registrationProbeFailure = true;

    await expect(
      adapter.uninstall({
        purge: false,
      }),
    ).rejects.toThrow("Copilot registration probe failed");
    await expect(
      access(dataRoot),
    ).resolves.toBeUndefined();
  });

  it("keeps a failed first install recoverable", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const runner = new FakeCommandRunner();
    runner.registrationProbeFailure = true;
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: {},
      platform: "win32",
    });

    await expect(adapter.install()).rejects.toThrow(
      "Copilot registration probe failed",
    );
    await expect(
      access(join(dataRoot, "data", "adapter-state.json")),
    ).resolves.toBeUndefined();
    runner.registrationProbeFailure = false;
    await expect(
      adapter.uninstall({
        purge: true,
      }),
    ).resolves.toMatchObject({
      status: "changed",
    });
    await expect(access(dataRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps concurrent internal Session registrations independent", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data-root");
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: {},
      platform: "win32",
    });
    await adapter.install();
    await Promise.all([
      registerInternalCopilotSession(dataRoot, "session-a"),
      registerInternalCopilotSession(dataRoot, "session-b"),
    ]);

    const identities = await Promise.all(
      [
        "session-a",
        "session-b",
      ].map((sessionId) =>
        adapter.resolveSession({
          adapterVersion: "1.0.82-0",
          cwd: runner.gitRoot,
          environment: {},
          sessionId,
        }),
      ),
    );
    expect(
      identities.map((identity) => identity.internalSession),
    ).toEqual([
      true,
      true,
    ]);
  });

  it("refuses to adopt or purge an unowned existing directory", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "existing-directory");
    const retainedPath = join(dataRoot, "user-file.txt");
    await mkdir(dataRoot, {
      recursive: true,
    });
    await writeFile(retainedPath, "retain", "utf8");
    const adapter = new CopilotCliAdapter({
      commandRunner: new FakeCommandRunner(),
      copilotHome: join(root, "copilot-home"),
      dataRoot,
      environment: {},
      platform: "win32",
    });

    await expect(adapter.enable("worker")).resolves.toMatchObject({
      status: "incompatible",
    });
    await expect(
      access(join(dataRoot, "data", "adapter-state.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(adapter.install()).rejects.toThrow(
      "Refusing to use unowned existing data root",
    );
    await expect(
      adapter.uninstall({
        purge: true,
      }),
    ).rejects.toThrow("ownership marker is missing or invalid");
    await expect(access(retainedPath)).resolves.toBeUndefined();
  });

  it.each([
    ["20.20.0", "fail"],
    ["22.15.99", "fail"],
    ["22.16.0", "pass"],
    ["22.18.0", "pass"],
    ["23.11.0", "pass"],
    ["24.14.0", "pass"],
    ["25.0.0", "pass"],
    ["26.0.0", "pass"],
  ])("reports Node %s runtime compatibility as %s", async (version, status) => {
    const root = await createTemporaryDirectory();
    const adapter = new CopilotCliAdapter({
      commandRunner: new FakeCommandRunner(),
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });
    const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node");
    if (descriptor === undefined) {
      throw new Error("The Node.js version descriptor is unavailable.");
    }
    Object.defineProperty(process.versions, "node", { ...descriptor, value: version });
    try {
      const health = await adapter.doctor();
      expect(health.checks).toContainEqual({
        id: "runtime.node",
        message: status === "pass"
          ? `Node ${version} is supported.`
          : `Node ${version} is below the required >=22.16.0.`,
        status,
      });
    } finally {
      Object.defineProperty(process.versions, "node", descriptor);
    }
  });

  it("reports operational health including the synthetic capture path", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });
    await adapter.install();

    const health = await adapter.doctor();
    expect(health.status).toBe("degraded");
    expect(health.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "runtime.node",
          status: "pass",
        }),
        expect.objectContaining({
          id: "storage.sqlite",
          status: "pass",
        }),
        expect.objectContaining({
          id: "capture.queue",
          status: "pass",
        }),
        expect.objectContaining({
          id: "capture.synthetic",
          status: "pass",
        }),
        expect.objectContaining({
          id: "learning.automatic",
          status: "warn",
          message: expect.stringContaining("correctionLearning"),
        }),
        expect.objectContaining({
          id: "copilot.provider",
          status: "warn",
        }),
      ]),
    );
    await adapter.enable("correction_learning");
    const enabledHealth = await adapter.doctor();
    expect(enabledHealth.checks).toContainEqual(expect.objectContaining({
      id: "learning.automatic", status: "pass", message: expect.stringContaining("enabled (automatic)"),
    }));
  });

  it("classifies opt-in online provider degradation without persisting output", async () => {
    const root = await createTemporaryDirectory();
    const runner = new FakeCommandRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome: join(root, "copilot-home"),
      dataRoot: join(root, "data-root"),
      environment: {},
      platform: "win32",
    });
    await adapter.install();

    await expect(
      adapter.doctor({
        online: true,
      }),
    ).resolves.toMatchObject({
      providerStatus: "available",
    });

    runner.providerResult = {
      exitCode: 1,
      stderr: "Authentication required. Sign in first.",
      stdout: "",
    };
    const signedOut = await adapter.doctor({
      online: true,
    });
    expect(signedOut).toMatchObject({
      providerStatus: "signed_out",
    });
    expect(JSON.stringify(signedOut)).not.toContain(
      "Authentication required",
    );

    runner.providerResult = {
      exitCode: 1,
      stderr: "Rate limit exceeded.",
      stdout: "",
    };
    await expect(
      adapter.doctor({
        online: true,
      }),
    ).resolves.toMatchObject({
      providerStatus: "rate_limited",
    });

    runner.providerResult = {
      exitCode: 124,
      stderr: "Copilot command timed out.",
      stdout: "",
    };
    await expect(
      adapter.doctor({
        online: true,
      }),
    ).resolves.toMatchObject({
      providerStatus: "unavailable",
    });

    runner.version = "1.0.70-0";
    await expect(
      adapter.doctor({
        online: true,
      }),
    ).resolves.toMatchObject({
      providerStatus: "incompatible",
    });
  });
});
