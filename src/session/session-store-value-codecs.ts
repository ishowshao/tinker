import type { MeasuredContextAnchor } from "../agent/context-meter";

export function recordFromSql(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function assertObjectKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  name: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  const missing = required.filter((key) => !(key in record));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${name} has invalid keys; unknown=${unknown.join(",") || "none"} missing=${missing.join(",") || "none"}.`,
    );
  }
}

export function stringFromSql(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

export function sha256FromSql(value: unknown, name: string): string {
  const hash = stringFromSql(value, name);
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest.`);
  }
  return hash;
}

export function assertMeasuredContextAnchor(anchor: MeasuredContextAnchor): void {
  for (const [name, value] of [
    ["promptTokens", anchor.promptTokens],
    ["completionTokens", anchor.completionTokens],
    ["totalTokens", anchor.totalTokens],
    ["segmentCount", anchor.segmentCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `Measured context anchor ${name} must be a non-negative safe integer; received ${value}.`,
      );
    }
  }
  if (anchor.totalTokens !== anchor.promptTokens + anchor.completionTokens) {
    throw new Error(
      "Measured context anchor totalTokens must equal promptTokens + completionTokens.",
    );
  }
  for (const [name, value] of [
    ["prefixHash", anchor.prefixHash],
    ["requestConfigHash", anchor.requestConfigHash],
    ["toolSchemaHash", anchor.toolSchemaHash],
  ] as const) {
    if (!/^[0-9a-f]{64}$/.test(value)) {
      throw new Error(`Measured context anchor ${name} must be a SHA-256 digest.`);
    }
  }
}

export function nullableStringFromSql(value: unknown, name: string): string | null {
  return value === null ? null : stringFromSql(value, name);
}

export function nullableTextFromSql(value: unknown, name: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string or null.`);
  }
  return value;
}

export function numberFromSql(value: unknown, name: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${name} must be a safe non-negative integer.`);
  }
  return number;
}

export function nullableNumberFromSql(value: unknown, name: string): number | null {
  return value === null ? null : numberFromSql(value, name);
}

export function numberFromJson(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value as number;
}

export function safeJsonInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer.`);
  }
  return value as number;
}

export function nonNegativeJsonInteger(value: unknown, name: string): number {
  const number = safeJsonInteger(value, name);
  if (number < 0) throw new Error(`${name} must be non-negative.`);
  return number;
}

export function positiveJsonInteger(value: unknown, name: string): number {
  const number = safeJsonInteger(value, name);
  if (number < 1) throw new Error(`${name} must be positive.`);
  return number;
}

export function nonEmptyStringFromJson(value: unknown, name: string): string {
  const text = stringFromSql(value, name);
  if (text.trim() === "") throw new Error(`${name} must not be empty.`);
  return text;
}

export function enumFromSql<const T extends readonly string[]>(
  value: unknown,
  values: T,
  name: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${name} has unsupported value ${JSON.stringify(value)}.`);
  }
  return value;
}

export function timestampFromSql(value: unknown, name: string): string {
  return timestampValue(stringFromSql(value, name), name);
}

export function timestampValue(value: string, name: string): string {
  if (Number.isNaN(Date.parse(value)) || !value.endsWith("Z")) {
    throw new Error(`${name} must be a UTC ISO-8601 timestamp.`);
  }
  return value;
}

export function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} is not valid JSON.`, { cause: error });
  }
}
