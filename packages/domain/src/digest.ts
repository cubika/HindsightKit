import {
  createHash,
  createHmac,
} from "node:crypto";

const canonicalize = (
  value: unknown,
  ancestors: ReadonlySet<object>,
): unknown => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : `[${String(value)}]`;
  }
  if (typeof value === "bigint") {
    return `[bigint:${value.toString()}]`;
  }
  if (typeof value === "undefined") {
    return "[undefined]";
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return `[${typeof value}]`;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
    };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      binary: Buffer.from(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      ).toString("base64"),
      type: value.constructor.name,
    };
  }
  if (value instanceof ArrayBuffer) {
    return {
      binary: Buffer.from(value).toString("base64"),
      type: "ArrayBuffer",
    };
  }
  if (ancestors.has(value)) {
    return "[circular]";
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.map((child) => canonicalize(child, nextAncestors));
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [
        key,
        canonicalize(child, nextAncestors),
      ]),
  );
};

export const stableJson = (value: unknown): string =>
  JSON.stringify(canonicalize(value, new Set()));

export const sha256 = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("hex");

export const deletionIdentityDigest = (
  identityType: string,
  identifier: string,
  key: string,
): string =>
  createHmac("sha256", key)
    .update(stableJson({
      deletionIdentity: identifier.trim(),
      identityType,
    }))
    .digest("hex");
