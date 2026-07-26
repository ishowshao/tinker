import { describe, expect, test } from "bun:test";
import { createUuidV7, isCanonicalUuidV7 } from "../ids/uuid-v7";

describe("createUuidV7", () => {
  test("generates canonical UUIDv7 values", () => {
    expect(isCanonicalUuidV7(createUuidV7())).toBe(true);
  });
});

describe("isCanonicalUuidV7", () => {
  test("accepts a canonical UUIDv7", () => {
    expect(isCanonicalUuidV7("01980c6a-e7cd-70b2-91c2-b86da8a7b6bd")).toBe(true);
  });

  test("rejects non-canonical values", () => {
    for (const value of [
      "01980c6a-e7cd-40b2-91c2-b86da8a7b6bd",
      "01980c6a-e7cd-70b2-71c2-b86da8a7b6bd",
      "01980C6A-E7CD-70B2-91C2-B86DA8A7B6BD",
      "01980c6ae7cd70b291c2b86da8a7b6bd",
      "01980c6a-e7cd-70b2-91c2-b86da8a7b6bd-extra",
    ]) {
      expect(isCanonicalUuidV7(value)).toBe(false);
    }
  });
});
