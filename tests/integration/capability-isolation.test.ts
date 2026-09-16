import {
  access,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  CopilotCliAdapter,
  runInstalledCopilotExtension,
  type CommandResult,
  type CommandRunner,
} from "@provenloop/copilot-adapter";
import { PROVENLOOP_VERSION } from "@provenloop/contracts";
import {
  LocalMcpToolHandlers,
  runCaptureWorkerOnce,
} from "@provenloop/cli";
import {
  createCaptureDeduplicationKey,
} from "@provenloop/domain";
import {
  resolveWindowsProvenLoopPaths,
  WindowsCaptureQueue,
} from "@provenloop/platform-windows";
import {
  CanonicalSqliteStore,
} from "@provenloop/storage-sqlite";

const temporaryDirectories: string[] = [];

class FakeCopilotRunner implements CommandRunner {
  public marketplaceRegistered = false;
  public marketplaceSource: string | undefined;
  public pluginEnabled = false;
  public pluginInstalled = false;

  public run(
    executable: string,
    args: readonly string[],
  ): Promise<CommandResult> {
    if (executable !== "copilot") {
      return Promise.resolve({
        exitCode: 1,
        stderr: "Unexpected executable.",
        stdout: "",
      });
    }
    const command = args.join(" ");
    if (command === "--version") {
      return Promise.resolve(this.#success(
        "GitHub Copilot CLI 1.0.82-0.\n",
      ));
    }
    if (args.at(-1) === "--help") {
      return Promise.resolve(this.#success());
    }
    if (command === "plugin marketplace list") {
      return Promise.resolve(this.#success(
        this.marketplaceRegistered
          ? "Registered marketplaces:\n  provenloop-marketplace " +
            `(GitHub: ${this.marketplaceSource ?? "unknown"})\n`
          : "Registered marketplaces:\n",
      ));
    }
    if (command === "plugin list") {
      return Promise.resolve(this.#success(
        this.pluginInstalled
          ? `Live Plugins:\n  provenloop@provenloop-marketplace (v${PROVENLOOP_VERSION}) (${
              this.pluginEnabled ? "enabled" : "disabled"
            })\n`
          : "Live Plugins:\n",
      ));
    }
    if (
      command ===
      `plugin marketplace add cubika/ProvenLoop#v${PROVENLOOP_VERSION}`
    ) {
      this.marketplaceRegistered = true;
      this.marketplaceSource = args[3];
      return Promise.resolve(this.#success());
    }
    if (
      command ===
      "plugin install provenloop@provenloop-marketplace"
    ) {
      this.pluginInstalled = true;
      this.pluginEnabled = true;
      return Promise.resolve(this.#success());
    }
    if (
      command ===
      "plugins enable provenloop@provenloop-marketplace --plugin"
    ) {
      this.pluginEnabled = true;
      return Promise.resolve(this.#success());
    }
    if (
      command ===
      "plugins disable provenloop@provenloop-marketplace --plugin"
    ) {
      this.pluginEnabled = false;
      return Promise.resolve(this.#success());
    }
    return Promise.resolve({
      exitCode: 1,
      stderr: `Unsupported command: ${command}`,
      stdout: "",
    });
  }

  #success(stdout = ""): CommandResult {
    return {
      exitCode: 0,
      stderr: "",
      stdout,
    };
  }
}

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenloop-capability-isolation-"),
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

describe("capability isolation", () => {
  it("keeps retrieval, capture, worker, and correction learning independent", async () => {
    const root = await createTemporaryDirectory();
    const dataRoot = join(root, "data");
    const copilotHome = join(root, "copilot-home");
    const runner = new FakeCopilotRunner();
    const adapter = new CopilotCliAdapter({
      commandRunner: runner,
      copilotHome,
      dataRoot,
      environment: {},
      platform: "win32",
    });
    await adapter.install();
    await adapter.enable("retrieval");
    await adapter.enable("worker");
    await expect(
      access(resolveWindowsProvenLoopPaths(dataRoot).projectionDirty),
    ).resolves.toBeUndefined();

    await adapter.disable("retrieval");
    const handlers = new LocalMcpToolHandlers({
      cwd: root,
      dataRoot,
      now: () => new Date("2026-09-02T00:00:00.000Z"),
    });
    await expect(
      handlers.context({
        cwd: root,
        prompt: "Retrieve package guidance.",
        sessionId: "session-isolation",
        tokenBudget: 200,
      }),
    ).resolves.toMatchObject({
      items: [],
      status: "degraded",
      statusDetail: "Retrieval capability is disabled.",
    });
    await expect(
      handlers.feedback({
        action: "helpful",
        requestId: "request-isolation",
        sessionId: "session-isolation",
        targetId: "knowledge-isolation",
      }),
    ).rejects.toThrow("Retrieval capability is disabled.");
    expect(
      (await adapter.status()).capabilities.capabilities.find(
        (capability) => capability.capability === "capture",
      ),
    ).toMatchObject({
      enabled: true,
    });

    await adapter.disable("capture");
    let joined = false;
    await expect(
      runInstalledCopilotExtension({
        commandRunner: runner,
        copilotHome,
        dataRoot,
        environment: {
          SESSION_ID: "session-isolation",
        },
        joinSession: async () => {
          joined = true;
          throw new Error("Disabled capture must not join a Session.");
        },
      }),
    ).resolves.toEqual({
      status: "disabled",
    });
    expect(joined).toBe(false);

    const paths = resolveWindowsProvenLoopPaths(dataRoot);
    const queue = new WindowsCaptureQueue(paths.queue);
    await queue.initialize();
    const backlogEvent = {
      adapter: "copilot-cli",
      adapterVersion: "1.0.82-0",
      content: {
        message: "Capability isolation backlog event.",
      },
      eventType: "prompt.submitted",
      sessionId: "session-isolation",
      sourceEventId: "source-isolation",
      timestamp: "2026-09-02T00:00:00.000Z",
      trust: "user" as const,
    };
    await queue.enqueue(backlogEvent, {
      environment: {},
    });
    await adapter.disable("worker");
    await expect(
      runCaptureWorkerOnce({
        dataRoot,
      }),
    ).resolves.toEqual({
      status: "disabled",
    });
    expect(await queue.list("pending")).toHaveLength(1);

    await adapter.enable("worker");
    await expect(
      runCaptureWorkerOnce({
        admission: () => ({
          allowed: true,
          reasons: [],
        }),
        dataRoot,
      }),
    ).resolves.toMatchObject({
      failed: 0,
      status: "completed",
      stored: 1,
    });
    await expect(access(paths.projectionDirty)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const store = new CanonicalSqliteStore(paths.database);
    try {
      expect(
        store.rawEvent(
          createCaptureDeduplicationKey(backlogEvent),
        ),
      ).toBeDefined();

      await adapter.disable("correction_learning");
      await queue.enqueue(
        {
          ...backlogEvent,
          content: {
            message: [
              "Violated Constraint: Inspect package scripts",
              "Expected Behavior: Run the targeted test",
              "Trigger: package validation",
            ].join("\n"),
          },
          eventType: "user.corrected",
          sourceEventId: "source-correction-isolation",
          trust: "user",
        },
        {
          environment: {},
        },
      );
      await expect(
        runCaptureWorkerOnce({
          admission: () => ({
            allowed: true,
            reasons: [],
          }),
          dataRoot,
        }),
      ).resolves.toMatchObject({
        failed: 0,
        status: "completed",
      });
      expect(store.correctionKeys()).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
