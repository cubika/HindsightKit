import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const root = async () => {
  const base = join(process.cwd(), "evaluation-output", "probe-tests");
  await mkdir(base, { recursive: true });
  const path = await mkdtemp(join(base, "run-"));
  directories.push(path);
  return path;
};
const quoted = (path: string) => `'${path.replaceAll("'", "''")}'`;
const invoke = (command: string) => execFileSync("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-Command", command,
], {
  encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PSModulePath: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "Modules"),
  },
});
const json = async (path: string) =>
  JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/u, "")) as unknown;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe.skipIf(process.platform !== "win32")("evidence probe reports", () => {
  it("does not assert automated tests passed when no runner report was supplied", async () => {
    const directory = await root();
    const output = join(directory, "capability.json");
    const script = resolve("spikes", "f0", "run-capability-isolation-probe.ps1");
    const stub = `
      $global:flags = @{ capture = $true; retrieval = $true; worker = $true; correction_learning = $true }
      function global:provenloop {
        $global:LASTEXITCODE = 0
        switch ($args[0]) {
          'status' {
            @{ capabilities = @{ capabilities = @($global:flags.Keys | ForEach-Object {
              @{ capability = $_; enabled = $global:flags[$_] }
            }) } } | ConvertTo-Json -Depth 5
          }
          'enable' { $global:flags[$args[1]] = $true }
          'disable' { $global:flags[$args[1]] = $false }
          'worker' { '{"status":"disabled"}' }
        }
      }
    `;
    invoke(`${stub}; & ${quoted(script)} -DataRoot ${quoted(directory)} -OutputPath ${quoted(output)} | Out-Null`);
    expect(await json(output)).toMatchObject({
      automatedTestPassed: false,
      installedProbePassed: true,
      automatedTestEvidence: "not_supplied",
      status: "incomplete",
    });
    const tests = join(directory, "tests.json");
    await writeFile(tests, JSON.stringify({ success: true, numTotalTests: 3, numPassedTests: 3, numFailedTests: 0 }));
    invoke(`${stub}; & ${quoted(script)} -DataRoot ${quoted(directory)} -OutputPath ${quoted(output)} -AutomatedTestReport ${quoted(tests)} | Out-Null`);
    expect(await json(output)).toMatchObject({
      automatedTestPassed: true, automatedTestEvidence: "supplied_test_runner_report", status: "pass",
      automatedTestExecutedByProbe: false, automatedTestExecution: "reported_not_verified",
    });
    await writeFile(tests, JSON.stringify({
      success: true, numTotalTests: "passed", numPassedTests: "passed", numFailedTests: false,
    }));
    invoke(`${stub}; & ${quoted(script)} -DataRoot ${quoted(directory)} -OutputPath ${quoted(output)} -AutomatedTestReport ${quoted(tests)} | Out-Null`);
    expect(await json(output)).toMatchObject({ automatedTestPassed: false, status: "incomplete" });
  });

  it("binds supplied paired samples and rejects null samples rather than converting them to zero", async () => {
    const directory = await root();
    const baseline = join(directory, "baseline.json");
    const enabled = join(directory, "enabled.json");
    const output = join(directory, "paired.json");
    const script = resolve("spikes", "f0", "run-paired-latency-probe.ps1");
    await writeFile(baseline, JSON.stringify(Array.from({ length: 100 }, () => 100)));
    await writeFile(enabled, JSON.stringify(Array.from({ length: 100 }, () => 105)));
    const command = `& ${quoted(script)} -DataRoot ${quoted(directory)} -BaselineSamples ${quoted(baseline)} -ProvenLoopSamples ${quoted(enabled)} -OutputPath ${quoted(output)} | Out-Null`;
    invoke(command);
    expect(await json(output)).toMatchObject({
      evidenceKind: "supplied_measurements", pairing: "caller_supplied_order",
      sampleCount: 100, foregroundAddedLatencyP95Ms: 5,
    });
    await writeFile(baseline, JSON.stringify([null, ...Array.from({ length: 99 }, () => 100)]));
    expect(() => invoke(command)).toThrow();
  });
});
