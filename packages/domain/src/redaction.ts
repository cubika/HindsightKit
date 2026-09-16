import type {
  CaptureContent,
  CaptureRedaction,
  JsonValue,
} from "@provenloop/contracts";
import { CAPTURE_REDACTION_RULE_VERSION } from "@provenloop/contracts";

import { sha256 } from "./digest.js";

const REDACTED = "[REDACTED]";
const BINARY_OMITTED = "[BINARY OMITTED]";
const CIRCULAR_OMITTED = "[CIRCULAR OMITTED]";
const TRUNCATED = "[TRUNCATED]";

const knownSecretPatterns = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/u,
  /github_pat_[A-Za-z0-9_]{20,}/u,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/u,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/u,
  /xox[baprs]-[A-Za-z0-9-]{20,}/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/iu,
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
];

const knownSecretReplacementPatterns = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/gu,
  /github_pat_[A-Za-z0-9_]{20,}/gu,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/gu,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/gu,
  /xox[baprs]-[A-Za-z0-9-]{20,}/gu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/giu,
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/gu,
];

const secretAssignmentDetectionPattern =
  /(?:^|[\s{[(,;])["']?(?:access[_-]?token|api[_-]?key|auth(?:orization)?|client[_-]?secret(?:[_-]?value)?|password|passwd|private[_-]?key|secret(?:[_-]?(?:access[_-]?key|key|value))?|token)["']?\s*[:=]\s*(?:"[^"]{8,}"|'[^']{8,}'|[^\s,;}]{8,})/imu;

const secretAssignmentReplacementPattern =
  /(^|[\s{[(,;])(["']?)((?:access[_-]?token|api[_-]?key|auth(?:orization)?|client[_-]?secret(?:[_-]?value)?|password|passwd|private[_-]?key|secret(?:[_-]?(?:access[_-]?key|key|value))?|token))\2(\s*[:=]\s*)(?:"[^"]{8,}"|'[^']{8,}'|[^\s,;}]{8,})/gimu;

const tokenCandidates = (value: string): readonly string[] =>
  value.match(/[A-Za-z0-9+/=_]{24,}|[A-Fa-f0-9]{32,}/gu) ?? [];

const bitsPerSymbol = (value: string): number => {
  const frequencies = new Map<string, number>();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  return [...frequencies.values()].reduce((entropy, count) => {
    const probability = count / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
};

const isSafeStructuredIdentifier = (value: string): boolean =>
  /^[a-f0-9]{40}$/iu.test(value) ||
  /^[a-f0-9]{64}$/iu.test(value) ||
  /^[A-Za-z][A-Za-z0-9]{1,15}[_-][A-Za-z0-9_-]{8,128}$/u.test(
    value,
  ) ||
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
    value,
  );

const isSafeCommitSha = (value: string): boolean =>
  /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(value);

const isHighEntropyCandidate = (value: string): boolean =>
  bitsPerSymbol(value) >= 3.5;

export const containsKnownSecret = (value: string): boolean =>
  knownSecretPatterns.some((pattern) => pattern.test(value)) ||
  secretAssignmentDetectionPattern.test(value);

export const containsPotentialSecret = (value: string): boolean =>
  containsKnownSecret(value) ||
  tokenCandidates(value).some(isHighEntropyCandidate);

export const redactKnownSecrets = (value: string): string => {
  const knownRedacted = knownSecretReplacementPatterns.reduce(
    (redacted, pattern) => redacted.replace(pattern, REDACTED),
    value,
  );
  return knownRedacted.replace(
    secretAssignmentReplacementPattern,
    (
      _match,
      leading: string,
      quote: string,
      key: string,
      separator: string,
    ) => `${leading}${quote}${key}${quote}${separator}${REDACTED}`,
  );
};

export const redactPotentialSecrets = (value: string): string => {
  const knownRedacted = redactKnownSecrets(value);
  return tokenCandidates(knownRedacted).reduce(
    (redacted, candidate) =>
      isHighEntropyCandidate(candidate)
        ? redacted.replaceAll(candidate, REDACTED)
        : redacted,
    knownRedacted,
  );
};

export interface CaptureContentInput {
  readonly error?: unknown;
  readonly message?: string;
  readonly toolArguments?: unknown;
  readonly toolResult?: unknown;
}

export interface CaptureRedactionLimits {
  readonly maxArrayItems: number;
  readonly maxDepth: number;
  readonly maxObjectEntries: number;
  readonly messageChars: number;
  readonly safeErrorChars: number;
  readonly toolArgumentsChars: number;
  readonly toolResultChars: number;
}

export const DEFAULT_CAPTURE_REDACTION_LIMITS = {
  maxArrayItems: 100,
  maxDepth: 8,
  maxObjectEntries: 100,
  messageChars: 8_192,
  safeErrorChars: 4_096,
  toolArgumentsChars: 16_384,
  toolResultChars: 16_384,
} as const satisfies CaptureRedactionLimits;

interface RedactionState {
  readonly appliedRules: Set<string>;
  readonly droppedPaths: Set<string>;
  readonly redactedPaths: Set<string>;
  readonly truncatedPaths: Set<string>;
}

export interface RedactedCaptureContent {
  readonly content?: CaptureContent;
  readonly redactedArguments?: JsonValue;
  readonly redaction: CaptureRedaction;
  readonly resultDigest?: string;
}

const normalizedKey = (key: string): string =>
  key.toLowerCase().replaceAll(/[-_.]/gu, "");

const isSensitiveKey = (key: string): boolean =>
  [
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "setcookie",
  ].includes(normalizedKey(key)) ||
  [
    "accesstoken",
    "apikey",
    "clientsecret",
    "password",
    "passwd",
    "privatekey",
    "secret",
    "token",
  ].some(
    (suffix) =>
      normalizedKey(key).endsWith(suffix) ||
      normalizedKey(key).endsWith(`${suffix}key`) ||
      normalizedKey(key).endsWith(`${suffix}value`),
  ) ||
  normalizedKey(key).endsWith("secretaccesskey");

const isStructuredIdentifierKey = (key: string): boolean =>
  [
    "commit",
    "commitsha",
    "digest",
    "hash",
    "sha",
    "sha1",
    "sha256",
  ].includes(normalizedKey(key));

const isCommitParentKey = (key: string): boolean =>
  [
    "parent",
    "parentcommit",
    "parentcommits",
    "parents",
    "parentsha",
    "parentshas",
  ].includes(normalizedKey(key));

const isEnvironmentContainer = (key: string): boolean =>
  [
    "env",
    "environment",
    "environmentvariables",
  ].includes(normalizedKey(key));

const recordRedaction = (
  state: RedactionState,
  path: string,
  rule: string,
): void => {
  state.appliedRules.add(rule);
  state.redactedPaths.add(path);
};

const redactText = (
  value: string,
  path: string,
  state: RedactionState,
  allowStructuredIdentifier = false,
): string => {
  const knownRedacted = redactKnownSecrets(value);
  if (knownRedacted !== value) {
    recordRedaction(state, path, "known-secret");
  }
  return tokenCandidates(knownRedacted).reduce(
    (redacted, candidate) => {
      if (
        !isHighEntropyCandidate(candidate) ||
        (
          allowStructuredIdentifier &&
          isSafeStructuredIdentifier(candidate)
        )
      ) {
        return redacted;
      }
      recordRedaction(state, path, "high-entropy");
      return redacted.replaceAll(candidate, REDACTED);
    },
    knownRedacted,
  );
};

const truncateText = (
  value: string,
  limit: number,
  path: string,
  state: RedactionState,
): string => {
  if (value.length <= limit) {
    return value;
  }
  state.appliedRules.add("content-limit");
  state.truncatedPaths.add(path);
  return `${value.slice(0, limit)}${TRUNCATED}`;
};

const sanitizeValue = (
  value: unknown,
  path: string,
  state: RedactionState,
  limits: CaptureRedactionLimits,
  ancestors: ReadonlySet<object>,
  depth: number,
  allowStructuredIdentifier = false,
  commitShaOnly = false,
): JsonValue | undefined => {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return redactText(
      value,
      path,
      state,
      allowStructuredIdentifier &&
        (
          !commitShaOnly ||
          isSafeCommitSha(value)
        ),
    );
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return value;
    }
    state.appliedRules.add("unsupported-value");
    state.droppedPaths.add(path);
    return undefined;
  }
  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "undefined"
  ) {
    state.appliedRules.add("unsupported-value");
    state.droppedPaths.add(path);
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return redactText(`${value.name}: ${value.message}`, path, state);
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    state.appliedRules.add("binary-omission");
    state.droppedPaths.add(path);
    return BINARY_OMITTED;
  }
  if (ancestors.has(value)) {
    state.appliedRules.add("circular-omission");
    state.droppedPaths.add(path);
    return CIRCULAR_OMITTED;
  }
  if (depth >= limits.maxDepth) {
    state.appliedRules.add("content-limit");
    state.truncatedPaths.add(path);
    return TRUNCATED;
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayItems) {
      state.appliedRules.add("content-limit");
      state.truncatedPaths.add(path);
    }
    return value.slice(0, limits.maxArrayItems).map((child, index) =>
      sanitizeValue(
        child,
        `${path}[${index}]`,
        state,
        limits,
        nextAncestors,
        depth + 1,
        allowStructuredIdentifier,
        commitShaOnly,
      ) ?? null,
    );
  }

  const entries = Object.entries(value);
  if (entries.length > limits.maxObjectEntries) {
    state.appliedRules.add("content-limit");
    state.truncatedPaths.add(path);
  }
  const sanitized: Record<string, JsonValue> = {};
  for (const [key, child] of entries
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, limits.maxObjectEntries)) {
    const keyContainsSecret = containsPotentialSecret(key);
    let storedKey = keyContainsSecret ? "[REDACTED_KEY]" : key;
    if (keyContainsSecret) {
      let suffix = 2;
      while (Object.hasOwn(sanitized, storedKey)) {
        storedKey = `[REDACTED_KEY_${suffix}]`;
        suffix += 1;
      }
    }
    const childPath = `${path}.${storedKey}`;
    if (keyContainsSecret) {
      recordRedaction(state, childPath, "secret-key");
    }
    if (isEnvironmentContainer(key)) {
      state.appliedRules.add("environment-omission");
      state.droppedPaths.add(childPath);
      continue;
    }
    if (isSensitiveKey(key)) {
      recordRedaction(state, childPath, "sensitive-key");
      sanitized[storedKey] = REDACTED;
      continue;
    }
    const sanitizedChild = sanitizeValue(
      child,
      childPath,
      state,
      limits,
      nextAncestors,
      depth + 1,
      isStructuredIdentifierKey(key) || isCommitParentKey(key),
      isCommitParentKey(key),
    );
    if (sanitizedChild !== undefined) {
      sanitized[storedKey] = sanitizedChild;
    }
  }
  return sanitized;
};

const limitJsonValue = (
  value: JsonValue,
  original: unknown,
  limit: number,
  path: string,
  state: RedactionState,
): JsonValue => {
  if (JSON.stringify(value).length <= limit) {
    return value;
  }
  state.appliedRules.add("content-limit");
  state.truncatedPaths.add(path);
  return {
    digest: sha256(original),
    status: "truncated",
  };
};

const safeErrorText = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error !== null && typeof error === "object") {
    const record = error as Readonly<Record<string, unknown>>;
    return [
      typeof record.name === "string" ? record.name : undefined,
      typeof record.code === "string" ? record.code : undefined,
      typeof record.message === "string" ? record.message : undefined,
    ].filter((value): value is string => value !== undefined).join(": ");
  }
  return String(error);
};

const sorted = (values: ReadonlySet<string>): string[] =>
  [...values].sort();

export interface RedactedCaptureMetadata {
  readonly appliedRules: readonly string[];
  readonly redactedPaths: readonly string[];
  readonly values: Readonly<Record<string, string>>;
}

export const redactCaptureMetadata = (
  input: Readonly<Record<string, string | undefined>>,
  structuredIdentifierFields: ReadonlySet<string> = new Set(),
): RedactedCaptureMetadata => {
  const state: RedactionState = {
    appliedRules: new Set(),
    droppedPaths: new Set(),
    redactedPaths: new Set(),
    truncatedPaths: new Set(),
  };
  const values: Record<string, string> = {};
  for (const [field, value] of Object.entries(input)) {
    if (value === undefined) {
      continue;
    }
    values[field] = redactText(
      value,
      field === "sourceEventId"
        ? "sourceEventId"
        : `event.${field}`,
      state,
      structuredIdentifierFields.has(field),
    );
  }
  return {
    appliedRules: sorted(state.appliedRules),
    redactedPaths: sorted(state.redactedPaths),
    values,
  };
};

export const redactCaptureContent = (
  input: CaptureContentInput | undefined,
  limitOverrides: Partial<CaptureRedactionLimits> = {},
): RedactedCaptureContent => {
  const limits = {
    ...DEFAULT_CAPTURE_REDACTION_LIMITS,
    ...limitOverrides,
  };
  const state: RedactionState = {
    appliedRules: new Set(),
    droppedPaths: new Set(),
    redactedPaths: new Set(),
    truncatedPaths: new Set(),
  };
  if (input === undefined) {
    return {
      redaction: {
        appliedRules: [],
        droppedPaths: [],
        redactedPaths: [],
        ruleVersion: CAPTURE_REDACTION_RULE_VERSION,
        truncatedPaths: [],
      },
    };
  }

  const content: {
    message?: string;
    safeError?: string;
    toolResult?: JsonValue;
  } = {};
  let redactedArguments: JsonValue | undefined;
  if (input.message !== undefined) {
    content.message = truncateText(
      redactText(input.message, "content.message", state),
      limits.messageChars,
      "content.message",
      state,
    );
  }
  if (input.toolArguments !== undefined) {
    const sanitizedArguments = sanitizeValue(
      input.toolArguments,
      "event.redactedArguments",
      state,
      limits,
      new Set(),
      0,
    );
    if (sanitizedArguments !== undefined) {
      redactedArguments = limitJsonValue(
        sanitizedArguments,
        input.toolArguments,
        limits.toolArgumentsChars,
        "event.redactedArguments",
        state,
      );
    }
  }
  if (input.toolResult !== undefined) {
    const sanitizedResult = sanitizeValue(
      input.toolResult,
      "content.toolResult",
      state,
      limits,
      new Set(),
      0,
    );
    if (sanitizedResult !== undefined) {
      content.toolResult = limitJsonValue(
        sanitizedResult,
        input.toolResult,
        limits.toolResultChars,
        "content.toolResult",
        state,
      );
    }
  }
  if (input.error !== undefined) {
    content.safeError = truncateText(
      redactText(safeErrorText(input.error), "content.safeError", state),
      limits.safeErrorChars,
      "content.safeError",
      state,
    );
  }

  return {
    ...(Object.keys(content).length > 0
      ? {
          content,
        }
      : {}),
    ...(redactedArguments === undefined
      ? {}
      : {
          redactedArguments,
        }),
    redaction: {
      appliedRules: sorted(state.appliedRules),
      contentDigest: sha256(input),
      droppedPaths: sorted(state.droppedPaths),
      redactedPaths: sorted(state.redactedPaths),
      ruleVersion: CAPTURE_REDACTION_RULE_VERSION,
      truncatedPaths: sorted(state.truncatedPaths),
    },
    ...(input.toolResult === undefined
      ? {}
      : {
          resultDigest: sha256(input.toolResult),
        }),
  };
};

export const sanitizeDiagnostic = (
  value: unknown,
  maxChars = DEFAULT_CAPTURE_REDACTION_LIMITS.safeErrorChars,
): string => {
  const state: RedactionState = {
    appliedRules: new Set(),
    droppedPaths: new Set(),
    redactedPaths: new Set(),
    truncatedPaths: new Set(),
  };
  const sanitized = truncateText(
    redactText(safeErrorText(value), "diagnostic", state),
    maxChars,
    "diagnostic",
    state,
  ).trim();
  return sanitized.length > 0 ? sanitized : "Unknown error.";
};
