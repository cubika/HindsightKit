import { win32 } from "node:path";
import { SpawnCommandRunner, type CommandRunner } from "./command-runner.js";

export interface OwnedProcessRuntime {
  readonly nodeExecutable: string;
  readonly cliBinPath: string;
}
// The caller must bind extension identities to verified host startup evidence.
// A generic Copilot bootstrap command alone does not identify this plugin.
export interface VerifiedExtensionWorker {
  readonly pid: number;
  readonly parentPid: number;
  readonly createdAt: string;
  readonly parentCreatedAt: string;
  readonly ownerSid: string;
  readonly executable: string;
  readonly bootstrapPath: string;
  readonly extensionPath: string;
}
export interface OwnedProvenLoopProcessOptions {
  readonly dataRoot: string;
  readonly pluginRoots: readonly string[];
  readonly runtimes: readonly OwnedProcessRuntime[];
  readonly extensionWorkers?: readonly VerifiedExtensionWorker[];
  readonly launcherDataRoot?: string;
  readonly runner?: CommandRunner;
  readonly currentProcessId?: number;
  readonly powerShellExecutable?: string;
  readonly platform?: NodeJS.Platform;
}
export interface OwnedProvenLoopProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly createdAt: string;
  readonly executable: string;
  readonly kind: "mcp" | "launcher" | "extension";
}
export interface OwnedProvenLoopProcessInventory {
  readonly processes: readonly OwnedProvenLoopProcess[];
}
export interface OwnedProvenLoopStopResult {
  readonly pid: number;
  readonly status: "stopped" | "exited" | "identity_changed";
}
interface ProcessIdentity extends Omit<OwnedProvenLoopProcess, "kind"> {
  readonly ownerSid: string;
  readonly commandLine: string;
  readonly arguments: readonly string[];
}
interface Snapshot {
  readonly processes: readonly ProcessIdentity[];
  readonly observedPids: ReadonlySet<number>;
}

export const canonicalWindowsProcessPath = (path: string): string => {
  if (
    typeof path !== "string" || path.length > 4096 ||
    !/^[A-Za-z]:[\\/]/u.test(path) || /[<>:"|?*]/u.test(path.slice(2)) ||
    [...path].some((char) => char.charCodeAt(0) < 32) ||
    path.slice(3).split(/[\\/]/u).some((part) => part === "." || part === ".." || /[. ]$/u.test(part))
  ) {
    throw new Error("Owned process paths must be unambiguous absolute local Windows paths.");
  }
  return win32.normalize(path).replaceAll("\\", "/").replace(/\/$/u, "").toLowerCase();
};
export const sameWindowsProcessPath = (left: string, right: string): boolean => {
  try {
    return canonicalWindowsProcessPath(left) === canonicalWindowsProcessPath(right);
  } catch {
    return false;
  }
};
const absolutePath = canonicalWindowsProcessPath;
const samePath = sameWindowsProcessPath;
export const validProcessCreation = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 0x7fff_ffff_ffff_ffffn;
export const validOwnerSid = (value: unknown): value is string =>
  typeof value === "string" && /^S-1-[0-9]+(?:-[0-9]+){1,15}$/u.test(value) && value.length <= 184;
const validPid = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nativeStages = [
  "initialize", "compile", "enumerate", "ancestry", "owner", "arguments",
  "identity-open", "identity-creation", "identity-owner", "serialize",
  "target-open", "target-liveness", "target-owner", "target-identity",
  "parent-open", "parent-owner", "parent-identity", "terminate", "wait-exit",
];
const nativeReasons = [
  "native-error", "ancestor-cycle", "current-unavailable", "ancestor-incomplete",
  "ancestor-inaccessible", "inventory-bound", "owned-inventory-bound",
  "owner-changed", "protected-target", "target-inaccessible", "target-liveness",
  "parent-inaccessible", "termination-failed", "exit-deadline",
];
const nativeDiagnostic = (stderr: string): string => {
  // Never forward native stderr: PowerShell errors can embed commands and private paths.
  const match = /(?:^|\r?\n)PROVENLOOP_PROCESS_DIAGNOSTIC:(\{[^\r\n]{1,1024}\})(?:\r?\n|$)/u.exec(stderr.slice(-4096));
  if (!match?.[1]) return "native=unavailable";
  let value: unknown;
  try { value = JSON.parse(match[1]) as unknown; } catch { return "native=invalid"; }
  if (!record(value) || typeof value.stage !== "string" || !nativeStages.includes(value.stage) ||
    typeof value.reason !== "string" || !nativeReasons.includes(value.reason) ||
    !validPid(value.pid) || !validPid(value.nativeCode) ||
    !["hresult", "category", "line", "ancestorDepth"].every((key) => Number.isSafeInteger(value[key])) ||
    (value.hresult as number) < -0x8000_0000 || (value.hresult as number) > 0x7fff_ffff ||
    (value.category as number) < 0 || (value.category as number) > 31 ||
    (value.line as number) < 0 || (value.line as number) > 4096 ||
    (value.ancestorDepth as number) < 0 || (value.ancestorDepth as number) > 4096) return "native=invalid";
  return `stage=${value.stage}; reason=${value.reason}; pid=${value.pid}; ancestorDepth=${String(value.ancestorDepth)}; ` +
    `nativeCode=${value.nativeCode}; hresult=${String(value.hresult)}; category=${String(value.category)}; line=${String(value.line)}`;
};

export const WINDOWS_PROCESS_IDENTITY_SCRIPT = String.raw`Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ProvenLoopProcessIdentity {
  [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  public static string Creation(IntPtr handle) { long creation, exit, kernel, user; if(!GetProcessTimes(handle,out creation,out exit,out kernel,out user)) throw new Win32Exception(); return creation.ToString(); }
  public static bool SameObservedCreation(long exact, long observed) { return exact / 10 == observed / 10; }
  public static string[] Arguments(string command) { int count; IntPtr pointer=CommandLineToArgvW(command,out count); if(pointer==IntPtr.Zero) throw new Win32Exception(); try { string[] result=new string[count]; for(int i=0;i<count;i++) result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer,i*IntPtr.Size)); return result; } finally { LocalFree(pointer); } }
}
'@
function Same-Path([string]$left,[string]$right) {
  return [String]::Equals($left.Replace('/','\').TrimEnd('\'),$right.Replace('/','\').TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)
}
function Fail-Process([string]$reason) {
  $script:reason = $reason
  throw 'Owned process verification failed.'
}
function Protected-Ids($all,[int]$current) {
  $script:phase = 'ancestry'
  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  $first = $true
  while ($current -gt 0) {
    $script:diagnosticPid = $current
    $script:ancestorDepth = $seen.Count
    if (-not $seen.Add($current)) { Fail-Process 'ancestor-cycle' }
    $row = $all | Where-Object { [int]$_.ProcessId -eq $current } | Select-Object -First 1
    if ($null -eq $row) {
      if ($first) { Fail-Process 'current-unavailable' }
      $missing = [ProvenLoopProcessIdentity]::OpenProcess(0x101000,$false,[uint32]$current)
      if ($missing -ne [IntPtr]::Zero) {
        try { if ([ProvenLoopProcessIdentity]::WaitForSingleObject($missing,0) -ne 0) { Fail-Process 'ancestor-incomplete' } }
        finally { [void][ProvenLoopProcessIdentity]::CloseHandle($missing) }
        break
      }
      $script:nativeCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      if ($script:nativeCode -ne 87) { Fail-Process 'ancestor-inaccessible' }
      break
    }
    $first = $false
    $current = [int]$row.ParentProcessId
  }
  return ,$seen
}
function Read-Identity($row) {
  if (!$row.ExecutablePath -or !$row.CommandLine -or $row.CommandLine.Length -gt 32768) { return $null }
  $script:phase = 'identity-open'
  $script:diagnosticPid = [int]$row.ProcessId
  $handle = [ProvenLoopProcessIdentity]::OpenProcess(0x101000,$false,[uint32]$row.ProcessId)
  if ($handle -eq [IntPtr]::Zero) { return $null }
  try {
    if ([ProvenLoopProcessIdentity]::WaitForSingleObject($handle,0) -ne 258) { return $null }
    $script:phase = 'identity-creation'
    $created = [ProvenLoopProcessIdentity]::Creation($handle)
    $script:phase = 'identity-owner'
    $owner = Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid -OperationTimeoutSec 2
    if ($owner.ReturnValue -ne 0 -or ![ProvenLoopProcessIdentity]::SameObservedCreation([long]$created,$row.CreationDate.ToUniversalTime().ToFileTimeUtc())) { return $null }
    $script:phase = 'arguments'
    return @{pid=[int]$row.ProcessId;parentPid=[int]$row.ParentProcessId;createdAt=$created;executable=[string]$row.ExecutablePath;commandLine=[string]$row.CommandLine;arguments=@([ProvenLoopProcessIdentity]::Arguments($row.CommandLine));ownerSid=[string]$owner.Sid}
  } finally { [void][ProvenLoopProcessIdentity]::CloseHandle($handle) }
}
`;

const INVENTORY = String.raw`$script:phase = 'enumerate'
$all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5)
if ($all.Count -gt 4096) { Fail-Process 'inventory-bound' }
$protected = Protected-Ids $all ([int]$inputData.currentProcessId)
$script:phase = 'owner'
$script:nativeCode = 0
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rows = @()
$extensionParents = @()
foreach ($parentId in $inputData.extensionParentPids) {
  $parentRow = $all | Where-Object { [int]$_.ProcessId -eq [int]$parentId } | Select-Object -First 1
  if ($null -ne $parentRow) {
    $identity = Read-Identity $parentRow
    if ($null -ne $identity) { $extensionParents += $identity }
  }
}
foreach ($row in $all) {
  if ($protected.Contains([int]$row.ProcessId) -or -not $row.ExecutablePath -or -not $row.CommandLine) { continue }
  $matched = $false
  foreach ($executable in $inputData.executables) { if (Same-Path $row.ExecutablePath $executable) { $matched = $true; break } }
  if (-not $matched -or $row.CommandLine.Length -gt 32768) { continue }
  $script:phase = 'arguments'
  $script:diagnosticPid = [int]$row.ProcessId
  $arguments = [ProvenLoopProcessIdentity]::Arguments($row.CommandLine)
  $matched = $false
  foreach ($argument in $arguments) { foreach ($path in $inputData.paths) { if (Same-Path $argument $path) { $matched = $true; break } } }
  if (-not $matched) { continue }
  $identity = Read-Identity $row
  if ($null -eq $identity -or $identity.ownerSid -ne $sid) { continue }
  $rows += $identity
  if ($rows.Count -gt 64) { Fail-Process 'owned-inventory-bound' }
}
$script:phase = 'serialize'
@{currentUserSid=$sid;protectedIds=@($protected);extensionParents=@($extensionParents);parents=@($all | ForEach-Object { @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;executable=[string]$_.ExecutablePath} });processes=@($rows)} | ConvertTo-Json -Depth 6 -Compress
`;

const TERMINATE = String.raw`$target = $inputData.target
$script:phase = 'owner'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($sid -ne $target.ownerSid) { Fail-Process 'owner-changed' }
$script:phase = 'enumerate'
$all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5)
if ($all.Count -gt 4096) { Fail-Process 'inventory-bound' }
$protected = Protected-Ids $all ([int]$inputData.currentProcessId)
if ($protected.Contains([int]$target.pid)) { Fail-Process 'protected-target' }
$script:nativeCode = 0
$script:diagnosticPid = [int]$target.pid
$row = $all | Where-Object { [int]$_.ProcessId -eq [int]$target.pid } | Select-Object -First 1
if ($null -eq $row) { @{status='exited'} | ConvertTo-Json -Compress; exit 0 }
$script:phase = 'target-open'
$handle = [ProvenLoopProcessIdentity]::OpenProcess(0x101001,$false,[uint32]$target.pid)
if ($handle -eq [IntPtr]::Zero) {
  $script:nativeCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Fail-Process 'target-inaccessible'
}
$parentHandle = [IntPtr]::Zero
try {
  $script:phase = 'target-liveness'
  $wait = [ProvenLoopProcessIdentity]::WaitForSingleObject($handle,0)
  if ($wait -eq 0) { @{status='exited'} | ConvertTo-Json -Compress; exit 0 }
  if ($wait -ne 258) { Fail-Process 'target-liveness' }
  $script:phase = 'target-owner'
  $owner = Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid -OperationTimeoutSec 2
  $script:phase = 'target-identity'
  if ([ProvenLoopProcessIdentity]::Creation($handle) -ne $target.createdAt -or ![ProvenLoopProcessIdentity]::SameObservedCreation([long]$target.createdAt,$row.CreationDate.ToUniversalTime().ToFileTimeUtc()) -or $owner.ReturnValue -ne 0 -or $owner.Sid -ne $target.ownerSid -or [int]$row.ParentProcessId -ne [int]$target.parentPid -or -not (Same-Path $row.ExecutablePath $target.executable) -or $row.CommandLine -cne $target.commandLine) {
    @{status='identity_changed'} | ConvertTo-Json -Compress; exit 0
  }
  if ($null -ne $inputData.extensionParent) {
    $parent = $all | Where-Object { [int]$_.ProcessId -eq [int]$target.parentPid } | Select-Object -First 1
    if ($null -eq $parent -or -not (Same-Path $parent.ExecutablePath $inputData.extensionParent.executable)) { @{status='identity_changed'} | ConvertTo-Json -Compress; exit 0 }
    $script:phase = 'parent-open'
    $script:diagnosticPid = [int]$parent.ProcessId
    $parentHandle = [ProvenLoopProcessIdentity]::OpenProcess(0x101000,$false,[uint32]$parent.ProcessId)
    if ($parentHandle -eq [IntPtr]::Zero) {
      $script:nativeCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      Fail-Process 'parent-inaccessible'
    }
    $script:phase = 'parent-owner'
    $parentOwner = Invoke-CimMethod -InputObject $parent -MethodName GetOwnerSid -OperationTimeoutSec 2
    $script:phase = 'parent-identity'
    if ([ProvenLoopProcessIdentity]::WaitForSingleObject($parentHandle,0) -ne 258 -or [ProvenLoopProcessIdentity]::Creation($parentHandle) -ne $inputData.extensionParent.createdAt -or $parentOwner.ReturnValue -ne 0 -or $parentOwner.Sid -ne $target.ownerSid -or ![ProvenLoopProcessIdentity]::SameObservedCreation([long]$inputData.extensionParent.createdAt,$parent.CreationDate.ToUniversalTime().ToFileTimeUtc())) { @{status='identity_changed'} | ConvertTo-Json -Compress; exit 0 }
  }
  $script:phase = 'terminate'
  $script:diagnosticPid = [int]$target.pid
  if (-not [ProvenLoopProcessIdentity]::TerminateProcess($handle,0)) {
    $script:nativeCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Fail-Process 'termination-failed'
  }
  $script:phase = 'wait-exit'
  if ([ProvenLoopProcessIdentity]::WaitForSingleObject($handle,3000) -ne 0) { Fail-Process 'exit-deadline' }
  @{status='stopped'} | ConvertTo-Json -Compress
} finally {
  if ($parentHandle -ne [IntPtr]::Zero) { [void][ProvenLoopProcessIdentity]::CloseHandle($parentHandle) }
  [void][ProvenLoopProcessIdentity]::CloseHandle($handle)
}
`;

export class OwnedProvenLoopProcessController {
  readonly #runner: CommandRunner;
  readonly #currentProcessId: number;
  readonly #powerShell: string;
  readonly #inventories = new WeakMap<OwnedProvenLoopProcessInventory, readonly ProcessIdentity[]>();
  public constructor(private readonly options: OwnedProvenLoopProcessOptions) {
    if ((options.platform ?? process.platform) !== "win32") throw new Error("Owned process cleanup is Windows-only.");
    this.#runner = options.runner ?? new SpawnCommandRunner();
    this.#currentProcessId = options.currentProcessId ?? process.pid;
    this.#powerShell = options.powerShellExecutable ?? win32.join(
      process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
    );
    if (!validPid(this.#currentProcessId) || this.#currentProcessId === 0 ||
      options.pluginRoots.length > 16 || options.runtimes.length > 16 ||
      (options.extensionWorkers?.length ?? 0) > 32) {
      throw new Error("Invalid owned process cleanup scope.");
    }
    absolutePath(options.dataRoot);
    absolutePath(this.#powerShell);
    if (win32.basename(this.#powerShell).toLowerCase() !== "powershell.exe") {
      throw new Error("Expected the trusted Windows PowerShell executable.");
    }
    for (const root of options.pluginRoots) absolutePath(root);
    if (options.launcherDataRoot !== undefined) absolutePath(options.launcherDataRoot);
    for (const runtime of options.runtimes) {
      absolutePath(runtime.nodeExecutable);
      absolutePath(runtime.cliBinPath);
      if (win32.basename(runtime.nodeExecutable).toLowerCase() !== "node.exe" ||
        win32.basename(runtime.cliBinPath).toLowerCase() !== "bin.js") {
        throw new Error("Unsupported ProvenLoop runtime signature.");
      }
    }
    for (const extension of options.extensionWorkers ?? []) {
      if (!validPid(extension.pid) || extension.pid === 0 || !validPid(extension.parentPid) || extension.parentPid === 0 || extension.pid === extension.parentPid ||
        !validProcessCreation(extension.createdAt) || !validProcessCreation(extension.parentCreatedAt) || BigInt(extension.parentCreatedAt) >= BigInt(extension.createdAt) ||
        !validOwnerSid(extension.ownerSid) || win32.basename(extension.executable).toLowerCase() !== "copilot.exe" ||
        !samePath(extension.bootstrapPath, win32.join(win32.dirname(extension.executable), "preloads", "extension_bootstrap.mjs")) ||
        !options.pluginRoots.some((root) =>
          samePath(extension.extensionPath, win32.join(root, "extensions", "event-capture", "extension.mjs")))) {
        throw new Error("Invalid verified extension worker scope.");
      }
      absolutePath(extension.executable);
      absolutePath(extension.bootstrapPath);
    }
    if (new Set(options.extensionWorkers?.map((worker) => worker.pid)).size !== (options.extensionWorkers?.length ?? 0)) {
      throw new Error("Duplicate verified extension worker scope.");
    }
    this.options = {
      ...options,
      pluginRoots: [...options.pluginRoots],
      runtimes: options.runtimes.map((runtime) => ({ ...runtime })),
      extensionWorkers: options.extensionWorkers?.map((worker) => ({ ...worker })) ?? [],
    };
  }

  public async inspect(): Promise<OwnedProvenLoopProcessInventory> {
    const snapshot = await this.#snapshot();
    const identities = snapshot.processes.filter((entry) => this.#kind(entry) !== undefined);
    const processes = identities.map((entry): OwnedProvenLoopProcess => Object.freeze({
      pid: entry.pid,
      parentPid: entry.parentPid,
      createdAt: entry.createdAt,
      executable: entry.executable,
      kind: this.#kind(entry) as OwnedProvenLoopProcess["kind"],
    })).sort((a, b) => {
      const order = { extension: 0, mcp: 1, launcher: 2 };
      return order[a.kind] - order[b.kind] || a.pid - b.pid;
    });
    const inventory = Object.freeze({ processes: Object.freeze(processes) });
    this.#inventories.set(inventory, identities);
    return inventory;
  }

  public async stop(inventory: OwnedProvenLoopProcessInventory): Promise<readonly OwnedProvenLoopStopResult[]> {
    const expected = this.#inventories.get(inventory);
    if (!expected) throw new Error("Inspect owned processes with this controller before stopping them.");
    this.#inventories.delete(inventory);
    const results: OwnedProvenLoopStopResult[] = [];
    for (const candidate of inventory.processes) {
      const original = expected.find((entry) => entry.pid === candidate.pid);
      const snapshot = await this.#snapshot();
      const fresh = snapshot.processes.find((entry) => entry.pid === candidate.pid);
      if (!original || !fresh || !this.#kind(fresh) || JSON.stringify(original) !== JSON.stringify(fresh)) {
        results.push({ pid: candidate.pid, status: snapshot.observedPids.has(candidate.pid) ? "identity_changed" : "exited" });
        continue;
      }
      const worker = this.options.extensionWorkers?.find((entry) => entry.pid === candidate.pid);
      const response = await this.#run(TERMINATE, {
        target: fresh,
        extensionParent: candidate.kind === "extension" && worker
          ? { executable: worker.executable, createdAt: worker.parentCreatedAt } : null,
      });
      if (!record(response) || typeof response.status !== "string" ||
        !["stopped", "exited", "identity_changed"].includes(response.status)) {
        throw new Error("Invalid owned process termination result.");
      }
      results.push({ pid: candidate.pid, status: response.status as OwnedProvenLoopStopResult["status"] });
    }
    return results;
  }

  #kind(entry: ProcessIdentity): OwnedProvenLoopProcess["kind"] | undefined {
    const args = entry.arguments;
    if (!args[0] || !samePath(args[0], entry.executable)) return undefined;
    if (args.length === 6 && args[2] === "mcp" && args[3] === "serve" && args[4] === "--data-root" &&
      samePath(args[5] ?? "", this.options.dataRoot) &&
      this.options.runtimes.some((runtime) =>
        samePath(entry.executable, runtime.nodeExecutable) && samePath(args[1] ?? "", runtime.cliBinPath))) {
      return "mcp";
    }
    if (samePath(this.options.launcherDataRoot ?? "", this.options.dataRoot) &&
      samePath(entry.executable, this.#powerShell) && args.length === 7 &&
      args.slice(1, 6).map((arg) => arg.toLowerCase()).join("|") === "-noprofile|-noninteractive|-executionpolicy|bypass|-file" &&
      this.options.pluginRoots.some((root) => samePath(args[6] ?? "", win32.join(root, "scripts", "mcp-launcher.ps1")))) {
      return "launcher";
    }
    if (args.length === 2 && this.options.extensionWorkers?.some((worker) =>
      worker.pid === entry.pid && worker.parentPid === entry.parentPid &&
      entry.createdAt === worker.createdAt && entry.ownerSid === worker.ownerSid &&
      samePath(entry.executable, worker.executable) && samePath(args[1] ?? "", worker.bootstrapPath))) {
      return "extension";
    }
    return undefined;
  }

  async #snapshot(): Promise<Snapshot> {
    const value = await this.#run(INVENTORY, {
      executables: [...new Set([
        ...this.options.runtimes.map((entry) => entry.nodeExecutable),
        this.#powerShell,
        ...(this.options.extensionWorkers ?? []).map((entry) => entry.executable),
      ])],
      paths: [...new Set([
        ...this.options.runtimes.map((entry) => entry.cliBinPath),
        ...this.options.pluginRoots.map((root) => win32.join(root, "scripts", "mcp-launcher.ps1")),
        ...(this.options.extensionWorkers ?? []).map((entry) => entry.bootstrapPath),
      ])],
      extensionParentPids: [...new Set(this.options.extensionWorkers?.map((worker) => worker.parentPid))],
    });
    if (!record(value) || !validOwnerSid(value.currentUserSid) || !Array.isArray(value.parents) || value.parents.length > 4096 ||
      !Array.isArray(value.processes) || value.processes.length > 64 ||
      !Array.isArray(value.extensionParents) || value.extensionParents.length > 32) {
      throw new Error("Invalid owned process inventory.");
    }
    const parents = new Map<number, { readonly parentPid: number; readonly executable: string }>();
    for (const row of value.parents) {
      if (!record(row) || !validPid(row.pid) || !validPid(row.parentPid) ||
        parents.has(row.pid) || typeof row.executable !== "string" || row.executable.length > 4096) {
        throw new Error("Invalid process ancestry.");
      }
      parents.set(row.pid, { parentPid: row.parentPid, executable: row.executable });
    }
    const protectedIds = new Set<number>();
    if (value.protectedIds !== undefined && (!Array.isArray(value.protectedIds) || value.protectedIds.length > 4096 ||
      !value.protectedIds.every(validPid) || new Set(value.protectedIds).size !== value.protectedIds.length)) {
      throw new Error("Invalid protected process inventory.");
    }
    const nativeProtected = value.protectedIds === undefined ? undefined : new Set(value.protectedIds as number[]);
    for (let id = this.#currentProcessId; id !== 0;) {
      if (id !== this.#currentProcessId && !parents.has(id) && nativeProtected?.has(id)) {
        protectedIds.add(id);
        break;
      }
      if (protectedIds.has(id) || !parents.has(id)) throw new Error("Current process ancestry cannot be verified.");
      protectedIds.add(id);
      id = parents.get(id)?.parentPid as number;
    }
    for (const id of nativeProtected ?? []) protectedIds.add(id);
    const extensionParents = new Map<number, ProcessIdentity>();
    for (const parent of value.extensionParents) {
      const identity = this.#parseIdentity(parent, parents);
      if (extensionParents.has(identity.pid)) throw new Error("Duplicate extension parent identity.");
      extensionParents.set(identity.pid, identity);
    }
    const processes: ProcessIdentity[] = [];
    const seen = new Set<number>();
    for (const row of value.processes) {
      const identity = this.#parseIdentity(row, parents);
      if (seen.has(identity.pid)) throw new Error("Duplicate process identity.");
      seen.add(identity.pid);
      if (identity.ownerSid !== value.currentUserSid || protectedIds.has(identity.pid)) continue;
      if (win32.basename(identity.executable).toLowerCase() === "copilot.exe") {
        const worker = this.options.extensionWorkers?.find((entry) => entry.pid === identity.pid);
        const parent = extensionParents.get(identity.parentPid);
        if (this.#kind(identity) !== "extension" || !worker || !parent ||
          parent.createdAt !== worker.parentCreatedAt || parent.ownerSid !== worker.ownerSid ||
          !samePath(parent.executable, identity.executable)) continue;
      }
      processes.push(identity);
    }
    return { observedPids: new Set(parents.keys()), processes };
  }

  #parseIdentity(
    row: unknown,
    parents: ReadonlyMap<number, { readonly parentPid: number; readonly executable: string }>,
  ): ProcessIdentity {
    if (!record(row) || !validPid(row.pid) || row.pid === 0 || !validPid(row.parentPid) || row.pid === row.parentPid ||
      parents.get(row.pid)?.parentPid !== row.parentPid || !validProcessCreation(row.createdAt) ||
      typeof row.executable !== "string" || !samePath(parents.get(row.pid)?.executable ?? "", row.executable) ||
      typeof row.commandLine !== "string" || row.commandLine.length === 0 || row.commandLine.length > 32768 || row.commandLine.includes("\0") ||
      !Array.isArray(row.arguments) || row.arguments.length === 0 || row.arguments.length > 32 ||
      row.arguments.some((arg: unknown) => typeof arg !== "string" || arg.length > 32768 || arg.includes("\0")) ||
      !validOwnerSid(row.ownerSid)) {
      throw new Error("Invalid process identity.");
    }
    return {
      pid: row.pid, parentPid: row.parentPid, createdAt: row.createdAt, executable: row.executable,
      commandLine: row.commandLine, arguments: row.arguments as string[], ownerSid: row.ownerSid,
    };
  }

  async #run(program: string, payload: Record<string, unknown>): Promise<unknown> {
    const operation = program === INVENTORY ? "inspect" : "terminate";
    const encoded = Buffer.from(JSON.stringify({ ...payload, currentProcessId: this.#currentProcessId }), "utf8").toString("base64");
    const script = `$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
$script:phase='initialize'; $script:reason='native-error'; $script:nativeCode=0; $script:diagnosticPid=0; $script:ancestorDepth=0
try {
$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$script:phase='compile'
${WINDOWS_PROCESS_IDENTITY_SCRIPT}
${program}
} catch {
  $failure = $_
  $exception = $failure.Exception
  for ($i=0; $i -lt 4 -and $null -ne $exception.InnerException; $i++) { $exception=$exception.InnerException }
  if ($exception -is [ComponentModel.Win32Exception]) { $script:nativeCode=$exception.NativeErrorCode }
  [Console]::Error.WriteLine('PROVENLOOP_PROCESS_DIAGNOSTIC:'+(@{stage=$script:phase;reason=$script:reason;pid=$script:diagnosticPid;ancestorDepth=$script:ancestorDepth;nativeCode=$script:nativeCode;hresult=$exception.HResult;category=[int]$failure.CategoryInfo.Category;line=$failure.InvocationInfo.ScriptLineNumber} | ConvertTo-Json -Compress))
  exit 1
}`;
    const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
    if (encodedCommand.length + this.#powerShell.length + 100 > 32767) {
      throw new Error("Owned process command exceeds the Windows command-line bound.");
    }
    const started = Date.now();
    const result = await this.#runner.run(
      this.#powerShell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand], { timeoutMs: 15_000 },
    ).catch(() => {
      throw new Error(`Owned process ${operation} runner failed; no broader termination was attempted.`);
    });
    const outputBytes = Buffer.byteLength(result.stdout, "utf8");
    const diagnostic = `operation=${operation}; exitCode=${result.exitCode}; elapsedMs=${Date.now() - started}; outputBytes=${outputBytes}`;
    if (result.exitCode !== 0 || outputBytes > 512 * 1024) {
      const reason = result.exitCode === 124 ? "timeout" : result.exitCode === 127 ? "launch-failed" :
        outputBytes > 512 * 1024 ? "output-bound" : "native-failure";
      throw new Error(`Owned process inspection or cleanup failed; no broader termination was attempted. ` +
        `[${diagnostic}; failure=${reason}; ${nativeDiagnostic(result.stderr)}]`);
    }
    try {
      return JSON.parse(result.stdout.trim()) as unknown;
    } catch {
      throw new Error(`Invalid owned process command output. [${diagnostic}]`);
    }
  }
}
