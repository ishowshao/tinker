import { v7 as uuidv7 } from "uuid";

const CANONICAL_UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createUuidV7(): string {
  return uuidv7();
}

export function isCanonicalUuidV7(value: string): boolean {
  return CANONICAL_UUID_V7_PATTERN.test(value);
}
