import { describe, expect, test } from "bun:test";
import {
  formatMessageSource,
  MessageSourceParseError,
  parseMessageSource,
} from "../context/context-source";
import { runtimeIdFactory } from "../ids/runtime-id";

describe("message context source", () => {
  test("round-trips one canonical source for a UUIDv7 message ID", () => {
    const messageId = runtimeIdFactory.createMessageId();
    const source = formatMessageSource(messageId);

    expect(source).toBe(`ctx://message/${messageId}`);
    expect(parseMessageSource(source)).toBe(messageId);
    expect(formatMessageSource(parseMessageSource(source))).toBe(source);
  });

  test("rejects non-canonical IDs and unsupported source shapes", () => {
    const messageId = runtimeIdFactory.createMessageId();
    const invalid = [
      `ctx://message/${messageId.toUpperCase()}`,
      "ctx://message/550e8400-e29b-41d4-a716-446655440000",
      `ctx://message/${messageId}?page=1`,
      `ctx://message/${messageId}#fragment`,
      `ctx://message/${messageId}/`,
      `ctx://message/%30${messageId.slice(1)}`,
      `ctx://turn/${messageId}`,
      `ctx://checkpoint/${messageId}`,
      `file://${messageId}`,
      messageId,
    ];

    for (const source of invalid) {
      expect(() => parseMessageSource(source)).toThrow(MessageSourceParseError);
    }
  });
});
