import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const installer = await readFile("install.ps1", "utf8");
const prerequisiteEnd = installer.indexOf('Write-Step "Checking GitHub Copilot CLI"');
if (prerequisiteEnd === -1) {
  throw new Error("The installer prerequisite boundary is missing.");
}
const quoted = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const prerequisiteScript = quoted(installer.slice(0, prerequisiteEnd));

const checkPrerequisites = (
  nodeVersion: string,
  npmVersion: string,
  sqliteExitCode = 0,
  realNode = false,
): { status: string; message?: string; probe: string } => {
  const command = `
    $ErrorActionPreference = 'Stop'
    $global:sqliteProbe = ''
    function Write-Host {}
    function Get-Command {
      param([string]$Name, [string]$ErrorAction)
      switch ($Name) {
        'node.exe' { [pscustomobject]@{ Source = 'Invoke-TestNode' } }
        'npm.cmd' { [pscustomobject]@{ Source = 'Invoke-TestNpm' } }
        default { throw "Unexpected prerequisite command: $Name" }
      }
    }
    function Invoke-TestNode {
      $global:LASTEXITCODE = 0
      if ($args[0] -eq '--version') {
        ${quoted(nodeVersion)}
        return
      }
      if ($args[0] -ne '-e') { throw 'Unexpected Node.js invocation' }
      $global:sqliteProbe = [string]$args[1]
      ${realNode
        ? `& ${quoted(process.execPath)} @args`
        : `$global:LASTEXITCODE = ${sqliteExitCode}`}
    }
    function Invoke-TestNpm {
      if ($args[0] -ne '--version') { throw 'Unexpected npm invocation' }
      $global:LASTEXITCODE = 0
      ${quoted(npmVersion)}
    }
    try {
      & ([ScriptBlock]::Create(${prerequisiteScript}))
      @{ status = 'pass'; probe = $global:sqliteProbe } | ConvertTo-Json -Compress
    } catch {
      @{
        status = 'fail'
        message = $_.Exception.Message
        probe = $global:sqliteProbe
      } | ConvertTo-Json -Compress
    }
  `;
  return JSON.parse(execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", command,
  ], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PSModulePath: join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32", "WindowsPowerShell", "v1.0", "Modules",
      ),
    },
  })) as { status: string; message?: string; probe: string };
};

describe.skipIf(process.platform !== "win32")("installer runtime prerequisites", () => {
  it.each([
    ["v22.16.0", "11.0.0"],
    ["v22.18.0", "11.6.2"],
    ["v23.11.0", "11.6.2"],
    ["v24.14.0", "11.6.2"],
    ["v24.14.0", "12.0.0"],
    ["v26.0.0", "13.0.0"],
  ])("accepts Node %s and npm %s when the SQLite APIs are present", (node, npm) => {
    expect(checkPrerequisites(node, npm)).toMatchObject({ status: "pass" });
  });

  it.each(["v20.20.0", "v22.15.99"])("rejects Node %s below the minimum", (node) => {
    expect(checkPrerequisites(node, "11.6.2")).toMatchObject({
      status: "fail",
      message: expect.stringContaining("requires Node.js >=22.16.0"),
    });
  });

  it("rejects npm below the minimum", () => {
    expect(checkPrerequisites("v24.14.0", "10.99.99")).toMatchObject({
      status: "fail",
      message: expect.stringContaining("requires npm >=11"),
    });
  });

  it.each([
    ["not-a-version", "11.6.2"],
    ["v24.14.0", "not-a-version"],
  ])("does not accept malformed versions: Node %s, npm %s", (node, npm) => {
    expect(checkPrerequisites(node, npm).status).toBe("fail");
  });

  it("rejects a newer runtime when the SQLite probe fails", () => {
    expect(checkPrerequisites("v24.14.0", "12.0.0", 1)).toMatchObject({
      status: "fail",
      message: expect.stringContaining("node:sqlite DatabaseSync timeout and backup APIs"),
    });
  });

  it("runs the real SQLite probe without a PowerShell native warning exception", () => {
    expect(checkPrerequisites(`v${process.versions.node}`, "11.6.2", 0, true))
      .toMatchObject({ status: "pass" });
  });

  it("checks actual SQLite support, including an ignored timeout option", () => {
    const { probe } = checkPrerequisites("v24.14.0", "11.6.2");
    expect(probe).not.toBe("");
    const execute = (prefix: string) => spawnSync(process.execPath, ["-e", prefix + probe], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(execute("").status).toBe(0);
    expect(execute("require('node:sqlite').backup = undefined;").status).toBe(1);
    expect(execute(`
      const sqlite = require('node:sqlite');
      const OriginalDatabaseSync = sqlite.DatabaseSync;
      sqlite.DatabaseSync = function (path) { return new OriginalDatabaseSync(path); };
    `).status).toBe(1);
  });
});
