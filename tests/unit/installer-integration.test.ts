import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROVENLOOP_VERSION } from "@provenloop/contracts";
import { describe, expect, it } from "vitest";

const installer = (await readFile("install.ps1", "utf8")).replaceAll("\r\n", "\n");
const start = installer.indexOf('    Write-Step "Checking the target runtime integration state"');
const end = installer.indexOf("    Ensure-UserPath $installPrefix", start);
if (start < 0 || end < 0) throw new Error("Installer integration boundaries are missing.");
const quoted = (value: string): string => `'${value.replaceAll("'", "''")}'`;

interface IntegrationFixture {
  readonly installed: boolean;
  readonly version?: string;
  readonly source?: string;
  readonly inheritedInstallation?: boolean;
  readonly noAutoCollect?: boolean;
  readonly noLearning?: boolean;
  readonly statusExitCode?: number;
}

const runIntegration = (fixture: IntegrationFixture): {
  readonly status: string;
  readonly calls: string[];
  readonly existingInstallation: boolean;
  readonly message?: string;
} => {
  const status = {
    installed: fixture.installed,
    pluginInstalled: fixture.installed,
    pluginVersion: fixture.version ?? PROVENLOOP_VERSION,
    marketplaceSource: fixture.source ?? `cubika/ProvenLoop#v${PROVENLOOP_VERSION}`,
  };
  const command = `
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version Latest
    $Version = ${quoted(PROVENLOOP_VERSION)}
    $existingInstallation = $${fixture.inheritedInstallation === true}
    $NoAutoCollect = $${fixture.noAutoCollect === true}
    $NoLearning = $${fixture.noLearning === true}
    $provenLoopCommand = 'Invoke-TestProvenLoop'
    $global:integrationCalls = [Collections.Generic.List[string]]::new()
    function Write-Step {}
    function Write-Host {}
    function Require-Success([string]$Operation) {
      if ($LASTEXITCODE -ne 0) { throw "$Operation failed with exit code $LASTEXITCODE." }
    }
    function Invoke-TestProvenLoop {
      $global:LASTEXITCODE = 0
      $global:integrationCalls.Add(($args -join ' '))
      if ($args[0] -eq 'status') {
        $global:LASTEXITCODE = ${fixture.statusExitCode ?? 0}
        ${quoted(JSON.stringify(status))}
      }
    }
    try {
      ${installer.slice(start, end)}
      @{ status = 'pass'; calls = @($global:integrationCalls)
         existingInstallation = $existingInstallation } | ConvertTo-Json -Compress
    } catch {
      @{ status = 'fail'; calls = @($global:integrationCalls)
         existingInstallation = $existingInstallation
         message = $_.Exception.Message } | ConvertTo-Json -Compress
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
  }));
};

describe.skipIf(process.platform !== "win32")("installer integration recovery", () => {
  it.each([
    { enabled: false, consentRequired: true },
    { enabled: false, mode: "disabled", blockedBy: ["explicitly_disabled"] },
    { enabled: true, mode: "automatic", blockedBy: [] },
  ])("prints learning status from old and new runtimes under StrictMode: %j", (automaticLearning) => {
    const summaryStart = installer.indexOf('    Write-Host (\n        "Automatic learning: "');
    const summaryEnd = installer.indexOf('    Write-Host ""', summaryStart);
    expect(summaryStart).toBeGreaterThan(0); expect(summaryEnd).toBeGreaterThan(summaryStart);
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
      $ErrorActionPreference = 'Stop'
      Set-StrictMode -Version Latest
      $automaticLearningStatus = ${quoted(JSON.stringify({ automaticLearning }))} | ConvertFrom-Json
      ${installer.slice(summaryStart, summaryEnd)}
    `], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(output).toContain(`Automatic learning: ${automaticLearning.enabled ? "enabled" : "disabled"}`);
  });
  it("guides first use from repository readiness to a reviewed lesson and observable guidance", () => {
    const summaryStart = installer.indexOf('    Write-Host (\n        "Automatic learning: "');
    const summaryEnd = installer.indexOf("\n} finally {", summaryStart);
    expect(summaryStart).toBeGreaterThan(0); expect(summaryEnd).toBeGreaterThan(summaryStart);
    const script = "$ErrorActionPreference = 'Stop'\nSet-StrictMode -Version Latest\n" +
      "$automaticLearningStatus = '{\"automaticLearning\":{\"enabled\":true}}' | ConvertFrom-Json\n" +
      installer.slice(summaryStart, summaryEnd);
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(output).toContain("provenloop learning status --cwd");
    expect(output).toContain("Restart Copilot in that repository");
    expect(output).toContain("Review Knowledge and its source evidence");
    expect(output).toContain("Check Usage for guidance provided");
    expect(output).toContain("Guidance provided and explicit adoption are recorded separately");
    expect(output).not.toContain("acceptance start");
  });

  it("discovers an older installed integration even when inherited PATH misses its command", () => {
    expect(runIntegration({ installed: true, version: "0.1.0-alpha.0.10" }))
      .toMatchObject({ status: "pass", calls: ["status", "upgrade"], existingInstallation: true });
  });

  it("verifies an already matching version instead of uninstalling it again", () => {
    expect(runIntegration({ installed: true }))
      .toMatchObject({ status: "pass", calls: ["status", "install"] });
  });

  it("does not treat a mismatched marketplace as a matching installation", () => {
    expect(runIntegration({ installed: true, source: "cubika/ProvenLoop#old" }))
      .toMatchObject({ status: "pass", calls: ["status", "upgrade"] });
  });

  it.each([
    [{ installed: false }, ["status", "install --no-auto-collect"]],
    [{ installed: true }, ["status", "collection disable", "install --no-auto-collect"]],
    [{ installed: true, version: "0.1.0-alpha.0.10" }, ["status", "collection disable", "upgrade"]],
  ] as const)("honors disabled automatic collection for %j", (fixture, calls) => {
    expect(runIntegration({ ...fixture, noAutoCollect: true })).toMatchObject({ status: "pass", calls });
  });

  it("does not change integration when the target status command fails", () => {
    expect(runIntegration({ installed: true, statusExitCode: 3 })).toMatchObject({
      status: "fail",
      calls: ["status"],
      message: "Target integration status failed with exit code 3.",
    });
  });

  it.each([
    [{ installed: true }, "install"],
    [{ installed: true, version: "0.1.0-alpha.0.10" }, "upgrade"],
  ] as const)("persists NoLearning before starting the new integration for %j", (fixture, operation) => {
    expect(runIntegration({ ...fixture, noLearning: true })).toMatchObject({
      status: "pass", calls: ["status", "disable correction_learning", "disable retrieval", "learning disable", operation],
    });
  });
});
