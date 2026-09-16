import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import {
  fileURLToPath,
  pathToFileURL,
} from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { applyEdits, modify, parse } from "jsonc-parser";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const expectedVersion = JSON.parse(
  await readFile(
    resolve(repositoryRoot, "packages", "cli", "package.json"),
    "utf8",
  ),
).version;
// Windows CI can expose TEMP through an 8.3 alias; keep the owned fixture scope canonical.
const temporaryRoot = await realpath(await mkdtemp(
  join(tmpdir(), "provenloop-package-"),
));
const packageDirectory = join(temporaryRoot, "package");
const installDirectory = join(temporaryRoot, "install");
const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) {
  throw new Error(
    "npm_execpath is unavailable; run this check through npm.",
  );
}

const run = (
  executable,
  args,
  options = {},
) => new Promise((resolveRun, reject) => {
  const child = spawn(executable, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    shell: false,
    windowsHide: true,
  });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  if (options.input !== undefined) {
    child.stdin.end(options.input);
  }
  child.once("error", reject);
  child.once("close", (exitCode) => {
    resolveRun({
      exitCode: exitCode ?? 1,
      stderr,
      stdout,
    });
  });
});

const requireSuccess = (
  result,
  operation,
) => {
  if (result.exitCode !== 0) {
    throw new Error(
      `${operation} failed with exit code ${result.exitCode}:\n` +
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  if (result.stderr.includes("ExperimentalWarning: SQLite is an experimental feature")) {
    throw new Error(`${operation} emitted the SQLite experimental notice.`);
  }
};

const pathExists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

try {
  await mkdir(packageDirectory, {
    recursive: true,
  });
  const packed = await run(
    process.execPath,
    [
      npmCliPath,
      "pack",
      "--workspace",
      "@provenloop/cli",
      "--json",
      "--pack-destination",
      packageDirectory,
    ],
  );
  requireSuccess(packed, "npm pack");
  const [manifest] = JSON.parse(packed.stdout);
  if (
    manifest?.name !== "@provenloop/cli" ||
    manifest.version !== expectedVersion
  ) {
    throw new Error("npm pack returned unexpected package metadata.");
  }
  const files = new Set(
    manifest.files.map((file) => file.path),
  );
  for (const required of [
    "dist/bin.js",
    "dist/extension-entry.js",
    "dist/index.js",
    "fixtures/valid-supported-event/suite.json",
    "package.json",
  ]) {
    if (!files.has(required)) {
      throw new Error(`Packed artifact is missing ${required}.`);
    }
  }
  for (const path of files) {
    if (
      path.endsWith(".map") ||
      path.endsWith(".tsbuildinfo") ||
      path.includes("/src/") ||
      path.startsWith("tests/")
    ) {
      throw new Error(`Packed artifact contains forbidden path ${path}.`);
    }
  }

  const tarball = join(packageDirectory, manifest.filename);
  const installed = await run(
    process.execPath,
    [
      npmCliPath,
      "install",
      "--global",
      "--prefix",
      installDirectory,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
  );
  requireSuccess(installed, "tarball install");

  const installedPackageRoot = join(
    installDirectory,
    "node_modules",
    "@provenloop",
    "cli",
  );
  const installedManifest = JSON.parse(
    await readFile(
      join(installedPackageRoot, "package.json"),
      "utf8",
    ),
  );
  if (
    installedManifest.version !== manifest.version ||
    installedManifest.dependencies !== undefined
  ) {
    throw new Error(
      "Installed package metadata is not self-contained.",
    );
  }

  const binaryPath = join(
    installedPackageRoot,
    "dist",
    "bin.js",
  );
  const commandShim = join(
    installDirectory,
    "provenloop.cmd",
  );
  const cliModule = await import(
    pathToFileURL(
      join(installedPackageRoot, "dist", "index.js"),
    ).href
  );
  const extensionModule = await import(
    pathToFileURL(
      join(
        installedPackageRoot,
        "dist",
        "extension-entry.js",
      ),
    ).href
  );
  if (
    typeof cliModule.runCli !== "function" ||
    typeof cliModule.runMcpServer !== "function" ||
    typeof cliModule.runCaptureWorkerOnce !== "function" ||
    typeof cliModule.reconcileCurrentSessionCapture !== "function" ||
    typeof cliModule.collectLocalObservations !== "function" ||
    typeof cliModule.readLocalObservationSummary !== "function" ||
    typeof extensionModule.runInstalledCopilotExtension !== "function" ||
    typeof extensionModule.runProvenLoopCopilotExtension !== "function"
  ) {
    throw new Error("Installed runtime exports are incomplete.");
  }
  await Promise.all([
    access(binaryPath),
    access(commandShim),
  ]);
  const versionResult = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `& '${commandShim.replaceAll("'", "''")}' version`,
    ],
  );
  requireSuccess(versionResult, "installed command shim");
  if (
    JSON.parse(versionResult.stdout).version !== expectedVersion
  ) {
    throw new Error(
      "Installed command shim reported the wrong version.",
    );
  }

  const fakeCopilotDirectory = join(
    temporaryRoot,
    "fake-copilot",
  );
  const fakeCopilotSource = join(
    fakeCopilotDirectory,
    "Program.cs",
  );
  const fakeCopilotExecutable = join(
    fakeCopilotDirectory,
    "copilot.exe",
  );
  const fakeCopilotState = join(
    fakeCopilotDirectory,
    "state.txt",
  );
  await mkdir(fakeCopilotDirectory, {
    recursive: true,
  });
  await writeFile(
    fakeCopilotSource,
    `using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

public static class Program
{
    public static int Main(string[] args)
    {
        var statePath = Environment.GetEnvironmentVariable(
            "PROVENLOOP_FAKE_COPILOT_STATE");
        if (string.IsNullOrWhiteSpace(statePath))
        {
            Console.Error.WriteLine("Fake Copilot state path is missing.");
            return 2;
        }
        var state = File.Exists(statePath)
            ? new HashSet<string>(File.ReadAllLines(statePath))
            : new HashSet<string>();
        var command = string.Join(" ", args);
        if (command == "--version")
        {
            Console.WriteLine("GitHub Copilot CLI 1.0.82-0.");
            return 0;
        }
        if (command.EndsWith(" --help"))
        {
            return 0;
        }
        if (command == "plugin marketplace list")
        {
            Console.WriteLine("Registered marketplaces:");
            if (state.Contains("marketplace"))
            {
                var source = state.FirstOrDefault(
                    value => value.StartsWith("source="));
                Console.WriteLine(
                    "  provenloop-marketplace (GitHub: " +
                    (source == null
                        ? "unknown"
                        : source.Substring("source=".Length)) +
                    ")");
            }
            return 0;
        }
        if (command == "plugin list")
        {
            Console.WriteLine("Live Plugins:");
            if (state.Contains("plugin"))
            {
                Console.WriteLine(
                    "  provenloop@provenloop-marketplace (v${expectedVersion}) (" +
                    (state.Contains("enabled") ? "enabled" : "disabled") +
                    ")");
            }
            return 0;
        }
        if (
            command ==
            "plugin marketplace add cubika/ProvenLoop#v${expectedVersion}"
        )
        {
            state.Add("marketplace");
            state.RemoveWhere(value => value.StartsWith("source="));
            state.Add("source=" + args[3]);
        }
        else if (command == "plugin marketplace remove provenloop-marketplace")
        {
            state.Remove("marketplace");
            state.RemoveWhere(value => value.StartsWith("source="));
            state.Remove("plugin");
            state.Remove("enabled");
        }
        else if (command == "plugin install provenloop@provenloop-marketplace")
        {
            state.Add("plugin");
            state.Add("enabled");
        }
        else if (command == "plugin uninstall provenloop@provenloop-marketplace")
        {
            if (Environment.GetEnvironmentVariable("PROVENLOOP_FAKE_PLUGIN_LOCK") == "1")
            {
                Console.Error.WriteLine("The plugin directory is in use. (os error 32)");
                return 1;
            }
            state.Remove("plugin");
            state.Remove("enabled");
        }
        else if (
            command == "plugin marketplace update provenloop-marketplace" ||
            command == "plugin update provenloop@provenloop-marketplace")
        {
        }
        else
        {
            Console.Error.WriteLine("Unsupported fake command: " + command);
            return 1;
        }
        Directory.CreateDirectory(Path.GetDirectoryName(statePath));
        File.WriteAllLines(
            statePath,
            state.OrderBy(value => value).ToArray());
        return 0;
    }
}
`,
    "utf8",
  );
  const compiled = await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type " +
        `-Path '${fakeCopilotSource.replaceAll("'", "''")}' ` +
        `-OutputAssembly '${
          fakeCopilotExecutable.replaceAll("'", "''")
        }' -OutputType ConsoleApplication`,
    ],
  );
  requireSuccess(compiled, "fake Copilot compilation");

  const smokeEnvironment = {
    ...process.env,
    COPILOT_HOME: join(temporaryRoot, "copilot-home"),
    LOCALAPPDATA: join(temporaryRoot, "local-app-data"),
    PATH: `${fakeCopilotDirectory};${
      process.env.PATH ?? process.env.Path ?? ""
    }`,
    PROVENLOOP_FAKE_COPILOT_STATE: fakeCopilotState,
  };
  delete smokeEnvironment.Path;
  const dataRoot = join(
    temporaryRoot,
    "自定义数据",
  );
  await mkdir(smokeEnvironment.COPILOT_HOME, {
    recursive: true,
  });
  const originalSettings = `{
  // Preserve this user setting.
  "theme": "dark",
}
`;
  const settingsPath = join(
    smokeEnvironment.COPILOT_HOME,
    "settings.json",
  );
  await writeFile(settingsPath, originalSettings, "utf8");
  const runInstalledCli = (args) =>
    run(
      process.execPath,
      [
        binaryPath,
        ...args,
        "--data-root",
        dataRoot,
      ],
      {
        cwd: temporaryRoot,
        env: smokeEnvironment,
      },
    );

  requireSuccess(
    await runInstalledCli([
      "install",
    ]),
    "installed CLI install",
  );
  requireSuccess(await runInstalledCli(["enable", "correction_learning"]), "installed learning prerequisite");
  const automaticStatus = await runInstalledCli(["learning", "status"]);
  requireSuccess(automaticStatus, "installed automatic learning status");
  const automatic = JSON.parse(automaticStatus.stdout).automaticLearning;
  if (automatic.enabled !== true || automatic.mode !== "automatic" || automatic.consentedAt !== undefined) {
    throw new Error("Installed learning defaults are not effective or fabricate consent.");
  }
  requireSuccess(await runInstalledCli(["learning", "disable"]), "installed learning opt-out");
  requireSuccess(await runInstalledCli(["disable", "correction_learning"]), "installed prerequisite pause");
  requireSuccess(await runInstalledCli(["enable", "correction_learning"]), "installed prerequisite resume");
  const disabledStatus = await runInstalledCli(["learning", "status"]);
  requireSuccess(disabledStatus, "installed learning opt-out status");
  const disabledLearning = JSON.parse(disabledStatus.stdout).automaticLearning;
  if (disabledLearning.enabled !== false || disabledLearning.mode !== "disabled") {
    throw new Error("A capability toggle overrode explicit learning opt-out.");
  }
  requireSuccess(await runInstalledCli(["disable", "correction_learning"]), "restore installed smoke capability");
  const uiProcess = spawn(process.execPath, [binaryPath, "ui", "--no-open", "--port", "0", "--data-root", dataRoot], {
    cwd: temporaryRoot, env: smokeEnvironment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const uiExited = once(uiProcess, "close");
  let uiOutput = "";
  let uiError = "";
  try {
    const uiUrl = await new Promise((resolveReady, reject) => {
      const deadline = setTimeout(() => reject(new Error(`Installed UI startup timed out: ${uiError}`)), 10_000);
      uiProcess.stdout.on("data", (chunk) => {
        uiOutput += String(chunk);
        const match = /http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\//u.exec(uiOutput);
        if (match) { clearTimeout(deadline); resolveReady(match[0]); }
      });
      uiProcess.stderr.on("data", (chunk) => { uiError += String(chunk); });
      uiProcess.once("error", (error) => { clearTimeout(deadline); reject(error); });
      uiProcess.once("close", (code) => { clearTimeout(deadline); reject(new Error(`Installed UI exited before startup (${code}): ${uiError}`)); });
    });
    const page = await fetch(uiUrl, { signal: AbortSignal.timeout(5_000) });
    const pageText = await page.text();
    if (page.status !== 200 || !pageText.includes("Knowledge cards") || !pageText.includes(expectedVersion)) {
      throw new Error(`Installed UI overview failed (${page.status}).`);
    }
    const style = await fetch(`${uiUrl}style.css`, { signal: AbortSignal.timeout(5_000) });
    if (style.status !== 200 || !style.headers.get("content-type")?.includes("text/css") || !(await style.text()).includes("grid-template-columns")) {
      throw new Error("Installed UI assets are missing.");
    }
    uiProcess.kill("SIGTERM");
    await uiExited;
    let stillListening = false;
    try { await fetch(uiUrl, { signal: AbortSignal.timeout(1_000) }); stillListening = true; } catch { /* Expected after process exit. */ }
    if (stillListening) throw new Error("Installed UI is still listening after shutdown.");
    console.log("Verified installed UI overview, bundled CSS, and process shutdown.");
  } finally {
    if (uiProcess.exitCode === null && uiProcess.signalCode === null) uiProcess.kill();
    await uiExited;
  }
  const locatorPath = join(
    smokeEnvironment.LOCALAPPDATA,
    "ProvenLoopIntegration",
    "runtime.json",
  );
  const runtimeLocator = JSON.parse(
    await readFile(locatorPath, "utf8"),
  );
  if (
    runtimeLocator.product !== "ProvenLoopRuntime" ||
    runtimeLocator.version !== expectedVersion ||
    runtimeLocator.dataRoot !== dataRoot ||
    runtimeLocator.cliBinPath !== binaryPath ||
    runtimeLocator.extensionModuleUrl !==
      pathToFileURL(
        join(
          installedPackageRoot,
          "dist",
          "extension-entry.js",
        ),
      ).href
  ) {
    throw new Error("Installed runtime locator is invalid.");
  }
  const mcpLauncherResult = await run(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(
        repositoryRoot,
        "plugins",
        "provenloop",
        "scripts",
        "mcp-launcher.ps1",
      ),
    ],
    {
      env: smokeEnvironment,
      input:
        `${JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
        })}\n`,
    },
  );
  requireSuccess(
    mcpLauncherResult,
    "PowerShell 5.1 MCP launcher",
  );
  if (
    !mcpLauncherResult.stdout.includes(
      `"version":"${expectedVersion}"`,
    )
  ) {
    throw new Error(
      "PowerShell 5.1 MCP launcher returned the wrong runtime.",
    );
  }
  const initialization = mcpLauncherResult.stdout.trim().split(/\r?\n/u)
    .map((line) => JSON.parse(line))
    .find((message) => message.id === 1);
  if (!initialization?.result?.instructions?.includes("new coding task")) {
    throw new Error("Installed MCP runtime is missing its context-use instructions.");
  }
  const [
    marketplaceJson,
    pluginJson,
    mcpJson,
    extensionSource,
    mcpLauncher,
  ] = await Promise.all([
    readFile(
      join(
        repositoryRoot,
        ".github",
        "plugin",
        "marketplace.json",
      ),
      "utf8",
    ),
    readFile(
      join(
        repositoryRoot,
        "plugins",
        "provenloop",
        "plugin.json",
      ),
      "utf8",
    ),
    readFile(
      join(
        repositoryRoot,
        "plugins",
        "provenloop",
        ".mcp.json",
      ),
      "utf8",
    ),
    readFile(
      join(
        repositoryRoot,
        "plugins",
        "provenloop",
        "extensions",
        "event-capture",
        "extension.mjs",
      ),
      "utf8",
    ),
    readFile(
      join(
        repositoryRoot,
        "plugins",
        "provenloop",
        "scripts",
        "mcp-launcher.ps1",
      ),
      "utf8",
    ),
  ]);
  for (const manifestSource of [
    marketplaceJson,
    pluginJson,
  ]) {
    if (
      JSON.parse(manifestSource).version !== expectedVersion &&
      JSON.parse(manifestSource).metadata?.version !== expectedVersion
    ) {
      throw new Error("Installed plugin version is not release-bound.");
    }
  }
  const mcpManifest = JSON.parse(mcpJson);
  if (
    mcpManifest.mcpServers?.provenloop?.command !==
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" ||
    !mcpManifest.mcpServers?.provenloop?.args?.includes(
      "${PLUGIN_ROOT}\\scripts\\mcp-launcher.ps1",
    ) ||
    !extensionSource.includes("@github/copilot-sdk/extension") ||
    extensionSource.includes('from "@provenloop/') ||
    extensionSource.includes("provenloop runtime extension-path") ||
    !mcpLauncher.includes("$runtime.cliBinPath")
  ) {
    throw new Error(
      "Official plugin assets are not self-contained.",
    );
  }
  const retainedDataPath = join(
    dataRoot,
    "evaluation",
    "package-smoke-retained.txt",
  );
  await mkdir(dirname(retainedDataPath), {
    recursive: true,
  });
  await writeFile(retainedDataPath, "retained", "utf8");
  requireSuccess(
    await runInstalledCli([
      "upgrade",
    ]),
    "installed CLI upgrade",
  );
  if (!await pathExists(retainedDataPath)) {
    throw new Error("Upgrade did not preserve local data.");
  }
  const pluginRoot = join(
    smokeEnvironment.COPILOT_HOME, "installed-plugins",
    "provenloop-marketplace", "provenloop",
  );
  const pluginAssets = Object.fromEntries(await Promise.all([
    "plugin.json", ".mcp.json", "scripts/mcp-launcher.ps1",
    "extensions/event-capture/extension.mjs", "skills/provenloop-context/SKILL.md",
  ].map(async (name) => [
    name,
    await readFile(join(repositoryRoot, "plugins", "provenloop", name), "utf8"),
  ])));
  for (const [name, contents] of Object.entries(pluginAssets)) {
    await mkdir(dirname(join(pluginRoot, name)), { recursive: true });
    await writeFile(join(pluginRoot, name), `${contents}\n`);
  }
  const configPath = join(smokeEnvironment.COPILOT_HOME, "config.json");
  await writeFile(configPath, JSON.stringify({
    untouched: "preserve",
    installedPlugins: [{
      name: "provenloop", marketplace: "provenloop-marketplace",
      cache_path: pluginRoot, version: expectedVersion, source_sha: "old-source",
    }],
  }));
  const settingsBeforeRefresh = await readFile(settingsPath, "utf8");
  await writeFile(settingsPath, applyEdits(settingsBeforeRefresh, modify(
    settingsBeforeRefresh,
    ["extraKnownMarketplaces", "provenloop-marketplace"],
    { source: { source: "github", repo: "cubika/ProvenLoop", ref: `v${expectedVersion}` } },
    {},
  )));
  smokeEnvironment.PROVENLOOP_FAKE_PLUGIN_LOCK = "1";
  try {
    requireSuccess(await runInstalledCli(["upgrade"]), "packaged locked-directory recovery");
    for (const [name, contents] of Object.entries(pluginAssets)) {
      if (await readFile(join(pluginRoot, name), "utf8") !== contents) {
        throw new Error(`Packaged recovery did not restore the exact bundled asset ${name}.`);
      }
    }
    const refreshedConfig = JSON.parse(await readFile(configPath, "utf8"));
    if (
      refreshedConfig.untouched !== "preserve" ||
      refreshedConfig.installedPlugins[0]?.source_sha !== undefined ||
      parse(await readFile(settingsPath, "utf8")).theme !== "dark"
    ) {
      throw new Error("Packaged recovery altered unrelated configuration or fabricated source_sha.");
    }
  } finally {
    delete smokeEnvironment.PROVENLOOP_FAKE_PLUGIN_LOCK;
    await writeFile(settingsPath, settingsBeforeRefresh);
  }
  requireSuccess(
    await runInstalledCli([
      "status",
    ]),
    "installed CLI status",
  );
  const doctor = await runInstalledCli([
    "doctor",
  ]);
  if (doctor.exitCode > 1) {
    throw new Error(
      `installed CLI doctor failed:\n${doctor.stderr || doctor.stdout}`,
    );
  }
  const controlledWorker = await cliModule.runCaptureWorkerOnce({
    dataRoot,
    admission: () => ({ allowed: true, reasons: [] }),
  });
  if (
    controlledWorker.status !== "completed" ||
    controlledWorker.failed !== 0 ||
    controlledWorker.circuitOpenReasons.length !== 0
  ) {
    throw new Error(`Installed worker failed under controlled admission: ${JSON.stringify(controlledWorker)}`);
  }
  const workerCommand = await runInstalledCli(["worker", "run"]);
  let workerResult;
  try {
    workerResult = JSON.parse(workerCommand.stdout);
  } catch (error) {
    throw new Error(
      `Installed worker returned invalid JSON:\nstdout:\n${workerCommand.stdout}\nstderr:\n${workerCommand.stderr}`,
      { cause: error },
    );
  }
  const workerCompleted = workerCommand.exitCode === 0 &&
    workerResult?.status === "completed" &&
    workerResult.failed === 0 &&
    Array.isArray(workerResult.circuitOpenReasons) &&
    workerResult.circuitOpenReasons.length === 0;
  const pressureReasons = workerResult?.status === "circuit_open"
    ? workerResult.reasons : workerResult?.circuitOpenReasons;
  const workerResourceLimited = workerCommand.exitCode === 1 &&
    (workerResult?.status === "circuit_open" ||
      (workerResult?.status === "completed" && workerResult.failed === 0)) &&
    Array.isArray(pressureReasons) && pressureReasons.length > 0 &&
    pressureReasons.every((reason) => ["cpu", "disk", "memory"].includes(reason));
  if (!workerCompleted && !workerResourceLimited) {
    throw new Error(
      `Installed worker returned an unexpected result (exit ${workerCommand.exitCode}):\n` +
      `stdout:\n${workerCommand.stdout}\nstderr:\n${workerCommand.stderr}`,
    );
  }
  if (workerResourceLimited) {
    console.log(`Installed worker CLI preserved resource admission: ${pressureReasons.join(", ")}.`);
  }
  requireSuccess(
    await runInstalledCli([
      "remember", "--scope", "personal",
      "--content", "Run focused tests before merging.",
      "--when", "Changing code.",
    ]),
    "installed CLI remember",
  );
  const knowledgeList = await runInstalledCli([
    "knowledge", "list", "--scope", "personal",
  ]);
  requireSuccess(knowledgeList, "installed CLI Knowledge list");
  const [review] = JSON.parse(knowledgeList.stdout);
  if (
    review?.candidate?.evidenceTier !== "user_confirmed" ||
    review.candidate.state !== "active" ||
    !/^[a-f0-9]{64}$/u.test(review.expectedDigest ?? "")
  ) {
    throw new Error("Installed CLI did not persist a reviewable user-confirmed rule.");
  }
  requireSuccess(
    await runInstalledCli([
      "knowledge", "revoke", review.candidate.knowledgeId,
      "--scope", "personal", "--expect", review.expectedDigest, "--confirm",
    ]),
    "installed CLI Knowledge revoke",
  );
  const revoked = await runInstalledCli([
    "knowledge", "show", review.candidate.knowledgeId, "--scope", "personal",
  ]);
  requireSuccess(revoked, "installed CLI Knowledge show");
  if (JSON.parse(revoked.stdout).candidate?.state !== "archived") {
    throw new Error("Installed CLI did not preserve the revoked rule's audit history.");
  }
  const observations = await runInstalledCli(["observations", "show"]);
  requireSuccess(observations, "installed CLI observations");
  if (!Array.isArray(JSON.parse(observations.stdout))) {
    throw new Error("Installed CLI observations returned an invalid summary collection.");
  }
  requireSuccess(
    await runInstalledCli([
      "uninstall",
    ]),
    "installed CLI uninstall",
  );
  if (
    !await pathExists(dataRoot) ||
    await pathExists(join(dataRoot, "integration")) ||
    await pathExists(locatorPath) ||
    await readFile(settingsPath, "utf8") !== originalSettings
  ) {
    throw new Error(
      "Normal uninstall did not preserve data and restore settings.",
    );
  }
  requireSuccess(
    await runInstalledCli([
      "purge",
    ]),
    "installed CLI purge",
  );
  if (await pathExists(dataRoot)) {
    throw new Error("Purge did not remove the owned data root.");
  }

  const episodes = await run(
    process.execPath,
    [
      binaryPath,
      "eval",
      "episodes",
    ],
    {
      cwd: temporaryRoot,
    },
  );
  requireSuccess(episodes, "installed episode evaluation");
  const evaluation = await run(
    process.execPath,
    [
      binaryPath,
      "eval",
      "run",
      "--suite",
      "valid-supported-event",
      "--out",
      join(temporaryRoot, "evaluation"),
    ],
    {
      cwd: temporaryRoot,
    },
  );
  requireSuccess(evaluation, "installed evaluation fixture");

  console.log(
    `Verified ${manifest.name}@${manifest.version} ` +
    `(${manifest.size} bytes, ${files.size} files).`,
  );
} finally {
  await rm(temporaryRoot, {
    force: true,
    recursive: true,
  });
}
