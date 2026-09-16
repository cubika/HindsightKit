import type { CaptureQuality, JsonValue } from "@provenloop/contracts";
import { win32 } from "node:path";

export type { CaptureEvidence, CaptureQuality, RepositoryState } from "@provenloop/contracts";

export const newCaptureQuality = (): CaptureQuality => ({
  schemaVersion: 1,
  truncatedFields: [],
  omittedFields: [],
  originalLengths: {},
});

export const boundedCaptureQuality = (quality: CaptureQuality): CaptureQuality => {
  const lengths = Object.entries(quality.originalLengths);
  if (quality.truncatedFields.length <= 256 && quality.omittedFields.length <= 256 && lengths.length <= 256) {
    return quality;
  }
  const truncatedMarkers: string[] = [];
  const originalLengths = Object.fromEntries(lengths.slice(0, 253));
  if (lengths.length > 253) {
    truncatedMarkers.push("captureQuality.originalLengths");
    originalLengths["captureQuality.originalLengths"] =
      Math.max(lengths.length, quality.originalLengths["captureQuality.originalLengths"] ?? 0);
  }
  if (quality.truncatedFields.length > 256) {
    truncatedMarkers.push("captureQuality.truncatedFields");
    originalLengths["captureQuality.truncatedFields"] =
      Math.max(quality.truncatedFields.length, quality.originalLengths["captureQuality.truncatedFields"] ?? 0);
  }
  const omittedMarkers: string[] = [];
  if (quality.omittedFields.length > 256) {
    omittedMarkers.push("captureQuality.omittedFields");
    originalLengths["captureQuality.omittedFields"] =
      Math.max(quality.omittedFields.length, quality.originalLengths["captureQuality.omittedFields"] ?? 0);
  }
  if (quality.truncatedFields.length + truncatedMarkers.length > 256 &&
      !truncatedMarkers.includes("captureQuality.truncatedFields")) {
    truncatedMarkers.push("captureQuality.truncatedFields");
    originalLengths["captureQuality.truncatedFields"] =
      Math.max(quality.truncatedFields.length, quality.originalLengths["captureQuality.truncatedFields"] ?? 0);
  }
  return {
    ...quality,
    truncatedFields: [...truncatedMarkers, ...quality.truncatedFields].slice(0, 256),
    omittedFields: [...omittedMarkers, ...quality.omittedFields].slice(0, 256),
    originalLengths,
  };
};

export const recordOf = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};

export const boundedText = (
  value: string,
  maximum: number,
  quality: CaptureQuality,
  path: string,
): string => {
  if (value.length > maximum) {
    if (!quality.truncatedFields.includes(path)) quality.truncatedFields.push(path);
    quality.originalLengths[path] = value.length;
  }
  return Buffer.from(value.slice(0, maximum), "utf8").toString("utf8");
};

const scalarFields = [
  "command", "path", "file", "filePath", "filepath", "cwd", "target",
  "targetPath", "query", "description", "old_str", "new_str",
  "oldString", "newString", "oldText", "newText", "file_text",
  "patch", "input", "content", "detailedContent",
  "exitCode", "exit_code", "status", "reason", "success", "shellId", "mode", "detach",
] as const;
const arrayFields = ["paths", "files", "targets", "changedFiles"] as const;
const MAX_FIELDS_CHARS = 65_536;
const MAX_ARRAY_ITEMS = 32;

export const copyEvidenceValue = (
  value: unknown,
  maximum: number,
  quality: CaptureQuality,
  path: string,
): JsonValue | undefined => {
  if (typeof value === "string") {
    return boundedText(value, maximum, quality, path);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    quality.omittedFields.push(path);
    return { kind: "array", itemCount: value.length, status: "omitted_in_callback" };
  }
  if (typeof value !== "object") return undefined;
  const record = recordOf(value);
  const result: Record<string, JsonValue> = {};
  let remaining = MAX_FIELDS_CHARS;
  for (const key of scalarFields) {
    const field = record[key];
    if (typeof field === "string") {
      const copied = boundedText(field, Math.min(maximum, remaining), quality, `${path}.${key}`);
      result[key] = copied;
      remaining -= copied.length;
    } else if (typeof field === "number" && Number.isFinite(field)) {
      result[key] = field;
    } else if (typeof field === "boolean" || field === null) {
      result[key] = field;
    }
  }
  for (const key of arrayFields) {
    const field = record[key];
    if (!Array.isArray(field)) continue;
    if (field.length > MAX_ARRAY_ITEMS) {
      quality.truncatedFields.push(`${path}.${key}`);
      quality.originalLengths[`${path}.${key}`] = field.length;
    }
    const values: JsonValue[] = [];
    for (let index = 0; index < Math.min(field.length, MAX_ARRAY_ITEMS); index += 1) {
      const item: unknown = field[index];
      if (typeof item === "string") {
        const copied = boundedText(item, Math.min(maximum, remaining), quality, `${path}.${key}[${index}]`);
        values.push(copied);
        remaining -= copied.length;
      } else {
        quality.omittedFields.push(`${path}.${key}[${index}]`);
      }
    }
    result[key] = values;
  }
    if (Object.keys(result).length === 0) {
    quality.omittedFields.push(path);
    return { kind: "object", status: "omitted_in_callback" };
  }
  return result;
};

export const copyMcpArguments = (value: unknown, quality: CaptureQuality): JsonValue | undefined => {
  let nodes = 0; let remaining = 16_384;
  const copy = (input: unknown, depth: number, path: string): JsonValue | undefined => {
    nodes += 1;
    if (nodes > 256 || depth > 8 || remaining <= 0) { quality.omittedFields.push(path); return undefined; }
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : undefined;
    if (typeof input === "string") { const text = boundedText(input, remaining, quality, path); remaining -= text.length; return text; }
    if (Array.isArray(input)) {
      if (input.length > 64) quality.omittedFields.push(path);
      return input.slice(0, 64).map((entry, index) => copy(entry, depth + 1, `${path}[${index}]`) ?? null);
    }
    if (input === undefined || typeof input !== "object") return undefined;
    const result: Record<string, JsonValue> = {};
    const entries = Object.entries(input);
    if (entries.length > 64) quality.omittedFields.push(path);
    for (const [key, entry] of entries.slice(0, 64)) {
      if (key.length > 256) { quality.omittedFields.push(path); continue; }
      remaining -= key.length; const copied = copy(entry, depth + 1, `${path}.${key}`);
      if (copied !== undefined) Object.defineProperty(result, key, {value:copied,enumerable:true,writable:true,configurable:true});
    }
    return result;
  };
  return copy(value, 0, "toolArguments");
};

export const copyToolContentBlocks = (
  blocks: readonly unknown[],
  maximum: number,
  quality: CaptureQuality,
): JsonValue[] => {
  if (blocks.length > MAX_ARRAY_ITEMS) {
    quality.truncatedFields.push("toolResult.contents");
    quality.originalLengths["toolResult.contents"] = blocks.length;
  }
  let remaining = MAX_FIELDS_CHARS;
  return blocks.slice(0, MAX_ARRAY_ITEMS).map((value, index) => {
    const source = recordOf(value);
    const path = `toolResult.contents[${index}]`;
    if (source.type !== "terminal" && source.type !== "shell_exit" && source.type !== "text") {
      quality.omittedFields.push(path);
      return {
        type: typeof source.type === "string" ? boundedText(source.type, 64, quality, `${path}.type`) : "unknown",
        status: "omitted_in_callback",
      };
    }
    const copied: Record<string, JsonValue> = { type: source.type };
    for (const key of ["text", "cwd", "shellId", "outputFilePath", "outputPreview"] as const) {
      if (typeof source[key] === "string") {
        const text = boundedText(source[key], Math.min(maximum, remaining), quality, `${path}.${key}`);
        copied[key] = text;
        remaining -= text.length;
      } else if (source[key] !== undefined) {
        quality.omittedFields.push(`${path}.${key}`);
      }
    }
    if (typeof source.exitCode === "number" && Number.isFinite(source.exitCode)) copied.exitCode = source.exitCode;
    else if (source.exitCode !== undefined) quality.omittedFields.push(`${path}.exitCode`);
    if (typeof source.outputTruncated === "boolean") copied.outputTruncated = source.outputTruncated;
    return copied;
  });
};

export interface ShellExitResult {
  readonly exitCode: number;
  readonly cwd?: string;
  readonly shellId?: string;
}

export const structuredShellResult = (
  value: unknown,
  quality: CaptureQuality,
): ShellExitResult | undefined => {
  const result = recordOf(value);
  if (typeof result.content !== "string" || !Array.isArray(result.contents) ||
      quality.truncatedFields.includes("toolResult.contents") ||
      result.contents.some((block) => recordOf(block).status === "omitted_in_callback")) return undefined;
  const exits = result.contents
    .map(recordOf)
    .filter((block) => block.type === "terminal" || block.type === "shell_exit");
  if (exits.length !== 1) return undefined;
  const block = exits[0];
  if (block === undefined) return undefined;
  if (!Number.isSafeInteger(block.exitCode) ||
      (block.type === "terminal" && typeof block.text !== "string") ||
      (block.type === "shell_exit" && (typeof block.shellId !== "string" || block.shellId.length === 0)) ||
      [...quality.truncatedFields, ...quality.omittedFields].some((path) =>
        /^toolResult\.contents\[\d+\]\.(?:cwd|shellId|exitCode|type)$/u.test(path),
      )) return undefined;
  return {
    exitCode: block.exitCode as number,
    ...(typeof block.cwd === "string" ? { cwd: block.cwd } : {}),
    ...(typeof block.shellId === "string" ? { shellId: block.shellId } : {}),
  };
};

export interface CommandVerification {
  readonly commandFamily: string;
  readonly eventType: "test.completed" | "build.completed" | "verification.completed";
}

export const classifyVerificationCommand = (command: string): CommandVerification | undefined => {
  if (command.length > 8_192 || /[;&|><`$(){}\r\n]/u.test(command) ||
      /(?:^|\s)(?:--?(?:help|version|if-present|ignore-scripts|collect-only|co|fixtures|markers|listtests|list|dry-run|no-run|no-build|passwithnotests|pass-with-no-tests|cwd|prefix|directory|project)\b|-[hvC]\b)/iu.test(command)) {
    return undefined;
  }
  const tokens = command.trim().match(/"[^"]*"|'[^']*'|[^\s"']+/gu);
  if (tokens === null || tokens.length > 128 ||
      tokens.join(" ").replaceAll(/\s+/gu, " ") !== command.trim().replaceAll(/\s+/gu, " ")) {
    return undefined;
  }
  const words = tokens.map((token) => token.replace(/^(['"])(.*)\1$/u, "$2").toLowerCase());
  const first = words[0]?.replace(/\.(?:exe|cmd)$/u, "");
  const second = words[1];
  if ((first === "npm" || first === "pnpm" || first === "yarn") &&
      (second === "test" || (second === "run" && words[2] === "test"))) {
    return { commandFamily: `${first}-test`, eventType: "test.completed" };
  }
  if ((first === "npm" || first === "pnpm" || first === "yarn") && second === "run" &&
      words.length === 3 && /^test:[a-z0-9][a-z0-9_-]*$/u.test(words[2] ?? "")) {
    return { commandFamily: `${first}-test`, eventType: "test.completed" };
  }
  if ((first === "npm" || first === "pnpm" || first === "yarn") &&
      second === "run" && (words[2] === "build" || words[2] === "lint" || words[2] === "typecheck")) {
    return {
      commandFamily: `${first}-${words[2]}`,
      eventType: words[2] === "build" ? "build.completed" : "verification.completed",
    };
  }
  if ((first === "dotnet" || first === "cargo" || first === "go") &&
      (second === "test" || second === "build")) {
    return { commandFamily: `${first}-${second}`, eventType: `${second}.completed` };
  }
  if (first === "pytest" ||
      ((first === "python" || first === "python3") && second === "-m" && words[2] === "pytest")) {
    return { commandFamily: "pytest", eventType: "test.completed" };
  }
  if (first === "node" && second === "--test") {
    return { commandFamily: "node-test", eventType: "test.completed" };
  }
  if ((first === "vitest" && second === "run") ||
      (first === "npx" && second === "vitest" && words[2] === "run") ||
      (first === "npx" && second === "--no-install" && words[2] === "vitest" && words[3] === "run")) {
    return { commandFamily: "vitest", eventType: "test.completed" };
  }
  if (first === "git" && second === "diff" && words[2] === "--check") {
    return { commandFamily: "git-diff-check", eventType: "verification.completed" };
  }
  return undefined;
};

export const evidencePaths = (value: unknown): string[] => {
  const record = recordOf(value);
  const paths: string[] = [];
  for (const key of ["path", "file", "filePath", "filepath", "target", "targetPath"] as const) {
    const field = record[key];
    if (typeof field === "string" && field.trim().length > 0) paths.push(field.trim());
  }
  for (const key of arrayFields) {
    const field = record[key];
    if (Array.isArray(field)) {
      for (const item of field.slice(0, MAX_ARRAY_ITEMS) as unknown[]) {
        if (typeof item === "string" && item.trim().length > 0) paths.push(item.trim());
      }
    }
  }
  return [...new Set(paths)].slice(0, MAX_ARRAY_ITEMS);
};

export const commandTargetPaths = (command: string): string[] =>
  (command.match(/"[^"]*"|'[^']*'|[^\s"']+/gu) ?? [])
    .slice(1, 129)
    .map((token) => token.replace(/^(['"])(.*)\1$/u, "$2"))
    .filter((token) => !token.startsWith("-") &&
      (/[\\/]/u.test(token) || /\.(?:csproj|slnx?|py|rs|go)$/iu.test(token)))
    .slice(0, MAX_ARRAY_ITEMS);

export const pathsWithinWorkspace = (
  paths: readonly string[],
  worktree: string | undefined,
): boolean => worktree !== undefined && paths.every((path) => {
  const relative = win32.relative(win32.resolve(worktree), win32.resolve(worktree, path));
  return relative !== ".." && !relative.startsWith("..\\") && !win32.isAbsolute(relative);
});

export const resolveEvidencePaths = (
  paths: readonly string[],
  cwd: string | undefined,
): string[] | undefined => {
  if (cwd === undefined) return undefined;
  const resolved = paths.map((path) => win32.resolve(cwd, path));
  return resolved.reduce((size, path) => size + path.length, 0) <= MAX_FIELDS_CHARS
    ? [...new Set(resolved)]
    : undefined;
};

export const resolveEvidenceDirectory = (value: string, base: string | undefined): string | undefined =>
  value.trim().length === 0 ? undefined
    : win32.isAbsolute(value) ? win32.normalize(value)
    : base !== undefined && win32.isAbsolute(base) ? win32.resolve(base, value)
    : undefined;

export const patchTargetPaths = (value: string): string[] => {
  if (!value.startsWith("*** Begin Patch") || !value.trimEnd().endsWith("*** End Patch")) {
    return [];
  }
  const paths: string[] = [];
  const pattern = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gmu;
  for (const match of value.matchAll(pattern)) {
    paths.push(match[1]?.trim() ?? "");
    if (paths.length > MAX_ARRAY_ITEMS) return [];
  }
  return paths.filter((path) => path.length > 0);
};
