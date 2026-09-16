import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { SpawnCommandRunner } from "./command-runner.js";

interface ApprovalSdk {
  CopilotClient: new (options: unknown) => {
    createSession(options: unknown): Promise<{ rpc: { permissions: { locations: { addToolApproval(options: unknown): Promise<{success:boolean}> } } } }>;
    deleteSession(id: string): Promise<void>; stop(): Promise<unknown>;
  };
  RuntimeConnection: { forStdio(options: unknown): unknown };
}

const withApprovalDeadline = async <T>(operation: Promise<T>, stage: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Copilot hook approval timed out during ${stage}.`)), 15_000);
    })]);
  } finally { clearTimeout(timer); }
};

export async function approveCopilotLearningHooks(options: { readonly copilotHome?: string; readonly cwd: string; readonly version?: string; readonly environment?: Readonly<Record<string, string | undefined>> }): Promise<{version:string;locationKey:string;approved:boolean}> {
  const environment = options.environment ?? process.env;
  const runner = new SpawnCommandRunner();
  const detected = await runner.run("copilot", ["--version"], { environment, timeoutMs: 5000 });
  const version = detected.stdout.match(/GitHub Copilot CLI ([0-9.]+(?:-[0-9]+)?)/u)?.[1];
  if (version !== "1.0.84-1" || (options.version !== undefined && version !== options.version)) throw new Error("Repository hook approval is not verified for this Copilot version.");
  const git = await new SpawnCommandRunner().run("git", ["-C", options.cwd, "rev-parse", "--show-toplevel"], { timeoutMs: 5000 });
  if (git.exitCode !== 0 || resolve(git.stdout.trim()).toLowerCase() !== resolve(options.cwd).toLowerCase()) throw new Error("Hook approval requires the exact Git repository root.");
  const sdkPath = environment.COPILOT_SDK_PATH ? join(environment.COPILOT_SDK_PATH, "index.js")
    : environment.COPILOT_CLI_DIST_DIR ? join(environment.COPILOT_CLI_DIST_DIR, "copilot-sdk", "index.js")
    : join(homedir(), ".copilot", "pkg", "win32-x64", version, "copilot-sdk", "index.js");
  const sdk = await import(pathToFileURL(sdkPath).href) as ApprovalSdk;
  const executable = await runner.run("where.exe", ["copilot.exe"], { environment, timeoutMs: 5000 });
  const executablePath = executable.stdout.split(/\r?\n/u).find((line) => line.trim().toLowerCase().endsWith("copilot.exe"))?.trim();
  if (!executablePath) throw new Error("Copilot executable path is unavailable.");
  const sessionId = randomUUID();
  const client = new sdk.CopilotClient({ connection: sdk.RuntimeConnection.forStdio({ path: executablePath }),
    baseDirectory: options.copilotHome ?? environment.COPILOT_HOME ?? join(homedir(), ".copilot"), workingDirectory: options.cwd, logLevel: "none", env: { ...environment, PROVENLOOP_INTERNAL: "1" } });
  try {
    const session = await withApprovalDeadline(client.createSession({ sessionId, workingDirectory: options.cwd, enableConfigDiscovery: false,
      enableExperimentalMode: false, availableTools: [], mcpServers: {}, pluginDirectories: [],
      onPermissionRequest: () => ({ kind: "reject", feedback: "Only explicit repository hook approval is permitted." }) }), "session startup");
    const result = await withApprovalDeadline(session.rpc.permissions.locations.addToolApproval({ locationKey: resolve(options.cwd),
      approval: { kind: "extension-permission-access", extensionName: "plugin:provenloop:event-capture" } }), "repository permission persistence");
    if (!result.success) throw new Error("Copilot did not persist repository hook approval.");
    return {version,locationKey:resolve(options.cwd),approved:true};
  } finally {
    await withApprovalDeadline(client.deleteSession(sessionId), "session cleanup").catch(() => undefined);
    await withApprovalDeadline(client.stop(), "client shutdown");
  }
}

export const getCopilotAutomaticLearningHostCapability = (version: string | undefined) => ({
  status: version === "1.0.84-1" ? "requires_repository_approval" as const : "unverified" as const,
  reason: version === "1.0.84-1"
    ? "Automatic retrieval requires Copilot repository-scoped extension-permission-access approval before startup; without it capture continues without hooks."
    : "Automatic hook behavior has not been verified for this Copilot version.",
});

export async function hasCopilotLearningHookApproval(home: string, workingDirectory: string, version: string): Promise<boolean> {
  if (version !== "1.0.84-1") return false;
  try {
    const contents = await readFile(join(home, "permissions-config.json"), "utf8");
    if (Buffer.byteLength(contents, "utf8") > 128 * 1024) return false;
    const value = JSON.parse(contents) as { locations?: Record<string, { tool_approvals?: { kind?: unknown; extensionName?: unknown }[] }> };
    const location = Object.entries(value.locations ?? {}).find(([path]) => resolve(path).toLowerCase() === resolve(workingDirectory).toLowerCase());
    return location?.[1]?.tool_approvals?.some((approval) => approval.kind === "extension-permission-access" && approval.extensionName === "plugin:provenloop:event-capture") === true;
  } catch { return false; }
}
