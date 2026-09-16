import { win32 } from "node:path";

import type { CommandRunner } from "./command-runner.js";
import {
  canonicalWindowsProcessPath,
  sameWindowsProcessPath,
  validOwnerSid,
  validProcessCreation,
  WINDOWS_PROCESS_IDENTITY_SCRIPT,
  type VerifiedExtensionWorker,
} from "./owned-processes.js";

const MAX_EVIDENCE = 128;
const MAX_LINE_LENGTH = 8192;
const MAX_OUTPUT_BYTES = 512 * 1024;
const FILETIME_UNIX_EPOCH = 116444736000000000n;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validPid = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffff_ffff;

// The native probe supplies bounded evidence, not permission to terminate a PID.
// Both the parser and the controller independently validate its live identities.
const SCRIPT = String.raw`$all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5)
if ($all.Count -gt 4096) { throw 'Process inventory exceeds its bound.' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$evidence = @()
$candidates = 0
$totalBytes = 0
function Assert-LocalLogPath([string]$path) {
  if ($path -notmatch '^[A-Za-z]:[\\/]') { throw 'Log paths must be local and absolute.' }
  $item = Get-Item -LiteralPath $path -Force
  while ($null -ne $item) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Indirect legacy log paths are not supported.' }
    $parentPath = Split-Path -LiteralPath $item.FullName
    if (!$parentPath -or $parentPath -eq $item.FullName) { break }
    $item = Get-Item -LiteralPath $parentPath -Force
  }
}
foreach ($row in $all) {
  if ($row.Name -ne 'copilot.exe') { continue }
  $child = Read-Identity $row
  if ($null -eq $child -or $child.ownerSid -ne $sid -or $child.arguments.Count -ne 2) { continue }
  $bootstrap = Join-Path (Split-Path -LiteralPath $child.executable) 'preloads\extension_bootstrap.mjs'
  if (!(Same-Path $child.arguments[0] $child.executable) -or !(Same-Path $child.arguments[1] $bootstrap)) { continue }
  $parentRow = $all | Where-Object { $_.ProcessId -eq $child.parentPid } | Select-Object -First 1
  if ($null -eq $parentRow -or $parentRow.Name -ne 'copilot.exe') { continue }
  $parent = Read-Identity $parentRow
  if ($null -eq $parent -or $parent.ownerSid -ne $sid -or !(Same-Path $parent.executable $child.executable) -or [long]$parent.createdAt -ge [long]$child.createdAt) { continue }
  $indices = @()
  for ($i = 0; $i -lt $parent.arguments.Count; $i++) { if ($parent.arguments[$i] -ceq '--log-dir') { $indices += $i } }
  if ($indices.Count -ne 1 -or $indices[0] + 1 -ge $parent.arguments.Count) { continue }
  $directory = $parent.arguments[$indices[0] + 1]
  if (!(Test-Path -LiteralPath $directory -PathType Container)) { continue }
  $candidates++
  if ($candidates -gt 32) { throw 'Legacy extension candidates exceed their bound.' }
  Assert-LocalLogPath $directory
  $files = @(Get-ChildItem -LiteralPath $directory -File -Filter ('process-*-'+$parent.pid+'.log') | Select-Object -First 5)
  if ($files.Count -gt 4) { throw 'Legacy log inventory exceeds its bound.' }
  foreach ($file in $files) {
    Assert-LocalLogPath $file.FullName
    $stream = [IO.File]::Open($file.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
    try {
      if ($stream.Length -gt 8388608) { throw 'Legacy log exceeds its byte bound.' }
      $bytes = New-Object byte[] 8388609
      $read = 0
      while ($read -lt $bytes.Length) {
        $count = $stream.Read($bytes,$read,$bytes.Length-$read)
        if ($count -eq 0) { break }
        $read += $count
      }
      if ($read -gt 8388608) { throw 'Legacy log grew beyond its byte bound.' }
      $totalBytes += $read
      if ($totalBytes -gt 33554432) { throw 'Legacy evidence exceeds its total byte bound.' }
      $decoder = New-Object Text.UTF8Encoding($false,$true)
      $lines = $decoder.GetString($bytes,0,$read).Split([char]10)
    } finally { $stream.Dispose() }
    foreach ($line in $lines) {
      if (!$line.Contains('[rust:copilot_runtime::extensions::host]') -or !$line.Contains('[extension-bootstrap] starting: pid='+$child.pid+',')) { continue }
      if ($line.Length -gt 8192) { throw 'Legacy evidence line exceeds its bound.' }
      $evidence += @{child=$child;parent=$parent;logPath=$file.FullName;line=$line.TrimEnd([char]13)}
      if ($evidence.Count -gt 128) { throw 'Legacy evidence inventory exceeds its bound.' }
    }
  }
}
@{currentUserSid=$sid;evidence=@($evidence)} | ConvertTo-Json -Compress -Depth 6
`;

interface LegacyIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly createdAt: string;
  readonly executable: string;
  readonly ownerSid: string;
  readonly arguments: readonly string[];
}

const parseIdentity = (value: unknown): LegacyIdentity => {
  if (
    !record(value) || !validPid(value.pid) ||
    typeof value.parentPid !== "number" || (!validPid(value.parentPid) && value.parentPid !== 0) ||
    !validProcessCreation(value.createdAt) || !validOwnerSid(value.ownerSid) ||
    typeof value.executable !== "string" || !Array.isArray(value.arguments) ||
    value.arguments.length === 0 || value.arguments.length > 32 ||
    value.arguments.some((arg: unknown) => typeof arg !== "string" || arg.length > 32768 || arg.includes("\0")) ||
    typeof value.commandLine !== "string" || value.commandLine.length === 0 ||
    value.commandLine.length > 32768 || value.commandLine.includes("\0")
  ) {
    throw new Error("Invalid legacy extension process identity.");
  }
  canonicalWindowsProcessPath(value.executable);
  return {
    pid: value.pid, parentPid: value.parentPid, createdAt: value.createdAt,
    executable: value.executable, ownerSid: value.ownerSid, arguments: value.arguments as string[],
  };
};

export const parseLegacyExtensionEvidence = (
  output: string,
  pluginRoots: readonly string[],
): readonly VerifiedExtensionWorker[] => {
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) throw new Error("Legacy extension output exceeds its bound.");
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new Error("Invalid legacy extension command output."); }
  if (!record(value) || !validOwnerSid(value.currentUserSid) || !Array.isArray(value.evidence) || value.evidence.length > MAX_EVIDENCE) {
    throw new Error("Invalid legacy extension inventory.");
  }
  const extensions = pluginRoots.map((root) => {
    canonicalWindowsProcessPath(root);
    return win32.join(root, "extensions", "event-capture", "extension.mjs");
  });
  const workers = new Map<number, VerifiedExtensionWorker>();
  for (const evidence of value.evidence) {
    if (!record(evidence) || typeof evidence.logPath !== "string" ||
      typeof evidence.line !== "string" || evidence.line.length > MAX_LINE_LENGTH ||
      /[\r\n\0]/u.test(evidence.line)) throw new Error("Invalid legacy log evidence.");
    canonicalWindowsProcessPath(evidence.logPath);
    const child = parseIdentity(evidence.child);
    const parent = parseIdentity(evidence.parent);
    if (child.pid === parent.pid || child.parentPid !== parent.pid ||
      child.ownerSid !== value.currentUserSid || parent.ownerSid !== value.currentUserSid ||
      BigInt(parent.createdAt) >= BigInt(child.createdAt) ||
      win32.basename(child.executable).toLowerCase() !== "copilot.exe" ||
      !sameWindowsProcessPath(parent.executable, child.executable) ||
      !sameWindowsProcessPath(parent.arguments[0] ?? "", parent.executable) ||
      child.arguments.length !== 2 || !sameWindowsProcessPath(child.arguments[0] ?? "", child.executable)) {
      throw new Error("Legacy extension parent or owner identity does not match.");
    }
    const bootstrapPath = win32.join(win32.dirname(child.executable), "preloads", "extension_bootstrap.mjs");
    if (!sameWindowsProcessPath(child.arguments[1] ?? "", bootstrapPath)) throw new Error("Legacy extension bootstrap path does not match.");
    const logIndices = parent.arguments.flatMap((arg, index) => arg === "--log-dir" ? [index] : []);
    const logDirectory = logIndices.length === 1 ? parent.arguments[(logIndices[0] ?? 0) + 1] : undefined;
    if (!logDirectory || !sameWindowsProcessPath(win32.dirname(evidence.logPath), logDirectory) ||
      !new RegExp(`^process-[A-Za-z0-9._-]{1,128}-${parent.pid}[.]log$`, "u").test(win32.basename(evidence.logPath))) {
      throw new Error("Legacy extension log is not bound to its parent.");
    }
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z) +\[INFO\] +\[rust:copilot_runtime::extensions::host\] [^\r\n]{0,256}?\[extension-bootstrap\] starting: pid=([1-9]\d{0,9}), EXTENSION_PATH=([^,\r\n]+), SESSION_ID=([A-Za-z0-9._-]{1,128})(?:, [^\r\n]{0,2048})?$/u.exec(evidence.line.replace(/^\uFEFF/u, ""));
    if (!match) continue;
    const [, timestamp = "", pid, extensionPath = ""] = match;
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== timestamp.slice(0, 19)) continue;
    const createdMillis = Number((BigInt(child.createdAt) - FILETIME_UNIX_EPOCH) / 10_000n);
    if (Number(pid) !== child.pid || Math.abs(time - createdMillis) > 5000 ||
      !extensions.some((path) => sameWindowsProcessPath(path, extensionPath))) continue;
    const worker: VerifiedExtensionWorker = {
      pid: child.pid, parentPid: parent.pid, createdAt: child.createdAt, parentCreatedAt: parent.createdAt,
      ownerSid: child.ownerSid, executable: child.executable, bootstrapPath, extensionPath,
    };
    const previous = workers.get(child.pid);
    if (previous && JSON.stringify(previous) !== JSON.stringify(worker)) throw new Error("Conflicting legacy extension evidence.");
    workers.set(child.pid, worker);
    if (workers.size > 32) throw new Error("Legacy extension worker inventory exceeds its bound.");
  }
  return [...workers.values()];
};

/** Unknown bootstraps remain untouched; bounded host records attest only this plugin. */
export const discoverLegacyExtensionWorkers = async (
  runner: CommandRunner,
  pluginRoots: readonly string[],
  powerShellExecutable: string,
): Promise<readonly VerifiedExtensionWorker[]> => {
  if (pluginRoots.length > 16) throw new Error("Legacy plugin root inventory exceeds its bound.");
  for (const root of pluginRoots) canonicalWindowsProcessPath(root);
  canonicalWindowsProcessPath(powerShellExecutable);
  if (win32.basename(powerShellExecutable).toLowerCase() !== "powershell.exe") throw new Error("Expected Windows PowerShell.");
  if (pluginRoots.length === 0) return [];
  const script = `$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest\n${WINDOWS_PROCESS_IDENTITY_SCRIPT}\n${SCRIPT}`;
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  if (encodedCommand.length + powerShellExecutable.length + 100 > 32767) {
    throw new Error("Legacy discovery exceeds the Windows command-line bound.");
  }
  const result = await runner.run(
    powerShellExecutable,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
    { timeoutMs: 15_000 },
  );
  if (result.exitCode !== 0) throw new Error("Cannot verify legacy ProvenLoop extension processes.");
  return parseLegacyExtensionEvidence(result.stdout, pluginRoots);
};
