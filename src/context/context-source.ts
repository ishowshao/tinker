import { parseMessageId, type MessageId } from "../ids/runtime-id";

export type MessageSource = `ctx://message/${string}`;

const MESSAGE_SOURCE_PREFIX = "ctx://message/";

export class MessageSourceParseError extends Error {
  readonly code = "RECALL_SOURCE_INVALID" as const;

  constructor(source: string, options?: ErrorOptions) {
    super(`Invalid message source: ${JSON.stringify(source)}.`, options);
    this.name = "MessageSourceParseError";
  }
}

export function formatMessageSource(messageId: MessageId): MessageSource {
  const canonicalId = parseMessageId(messageId);
  return `${MESSAGE_SOURCE_PREFIX}${canonicalId}`;
}

export function parseMessageSource(source: string): MessageId {
  if (!source.startsWith(MESSAGE_SOURCE_PREFIX)) {
    throw new MessageSourceParseError(source);
  }
  try {
    return parseMessageId(source.slice(MESSAGE_SOURCE_PREFIX.length));
  } catch (error) {
    throw new MessageSourceParseError(source, { cause: error });
  }
}
