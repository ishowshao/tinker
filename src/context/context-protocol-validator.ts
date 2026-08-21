import type { MessageId, ProtocolFrameId, ToolCallId } from "../ids/runtime-id";
import {
  canonicalToolResultContentHash,
  toolResultDisplayText,
  validateToolResultContent,
} from "../agent/tool-result-content";
import {
  contentHash,
  userMessageHash,
  rawResultHash,
  validateReturnedToolObservation,
  type CanonicalMessageRecord,
  type ProtocolContextView,
  type ProtocolFrame,
  type ToolResultRecord,
} from "./protocol-frame";

export type ContextProtocolErrorCode =
  | "ledger_faulted"
  | "open_frame"
  | "ordinal_gap"
  | "frame_range_mismatch"
  | "duplicate_frame_id"
  | "duplicate_message_id"
  | "duplicate_tool_call_id"
  | "duplicate_provider_tool_call_id"
  | "invalid_system_frame"
  | "invalid_user_frame"
  | "invalid_assistant_frame"
  | "missing_tool_message"
  | "unexpected_tool_message"
  | "tool_message_order_mismatch"
  | "tool_message_identity_mismatch"
  | "missing_tool_result"
  | "tool_result_mismatch"
  | "content_hash_mismatch"
  | "raw_hash_mismatch";

export class ContextProtocolError extends Error {
  readonly code: ContextProtocolErrorCode;
  readonly frameId?: ProtocolFrameId;
  readonly messageId?: MessageId;
  readonly ordinal?: number;
  readonly toolCallId?: ToolCallId;

  constructor(
    code: ContextProtocolErrorCode,
    message: string,
    identity: {
      frameId?: ProtocolFrameId;
      messageId?: MessageId;
      ordinal?: number;
      toolCallId?: ToolCallId;
    } = {},
  ) {
    super(message);
    this.name = "ContextProtocolError";
    this.code = code;
    Object.assign(this, identity);
  }
}

export type ContextProtocolValidationOptions = {
  allowOpenTail?: boolean;
  fullIntegrity?: boolean;
};

export class ContextProtocolValidator {
  validate(
    view: ProtocolContextView,
    options: ContextProtocolValidationOptions = {},
  ): void {
    if (view.faulted) {
      fail("ledger_faulted", "Cannot build context from a faulted ledger.");
    }
    if (view.frames.length === 0 || view.messages.length === 0) {
      fail("invalid_system_frame", "Protocol context has no system frame.");
    }

    const messageIds = new Set<string>();
    const messagesByFrame = new Map<string, CanonicalMessageRecord[]>();
    for (let index = 0; index < view.messages.length; index += 1) {
      const message = requireItem(view.messages, index, "message");
      const expectedOrdinal = index + 1;
      if (message.ordinal !== expectedOrdinal) {
        fail(
          "ordinal_gap",
          `Message ordinal must be ${expectedOrdinal}; received ${message.ordinal}.`,
          identityForMessage(message),
        );
      }
      if (message.sessionId !== view.sessionId) {
        fail(
          "frame_range_mismatch",
          `Message ${message.messageId} belongs to another session.`,
          identityForMessage(message),
        );
      }
      if (messageIds.has(message.messageId)) {
        fail(
          "duplicate_message_id",
          `Duplicate message ID ${message.messageId}.`,
          identityForMessage(message),
        );
      }
      messageIds.add(message.messageId);
      const frameMessages = messagesByFrame.get(message.frameId) ?? [];
      frameMessages.push(message);
      messagesByFrame.set(message.frameId, frameMessages);

      if (
        options.fullIntegrity === true &&
        message.contentSha256 !==
          (message.role === "user"
            ? userMessageHash({
                role: "user",
                content: message.content,
                ...(message.attachments === undefined
                  ? {}
                  : { attachments: message.attachments }),
              })
            : message.role === "tool"
              ? canonicalToolResultContentHash(message.content)
              : contentHash(message.content))
      ) {
        fail(
          "content_hash_mismatch",
          `Content hash does not match message ${message.messageId}.`,
          identityForMessage(message),
        );
      }
    }

    const frameIds = new Set<string>();
    let expectedFirstOrdinal = 1;
    let openFrame: ProtocolFrame | undefined;
    const seenToolCallIds = new Set<string>();
    const usedResultCallIds = new Set<string>();
    const resultsByCallId = groupResults(view.toolResults);

    for (let index = 0; index < view.frames.length; index += 1) {
      const frame = requireItem(view.frames, index, "frame");
      if (frame.sessionId !== view.sessionId) {
        fail(
          "frame_range_mismatch",
          `Frame ${frame.frameId} belongs to another session.`,
          { frameId: frame.frameId },
        );
      }
      if (frameIds.has(frame.frameId)) {
        fail("duplicate_frame_id", `Duplicate frame ID ${frame.frameId}.`, {
          frameId: frame.frameId,
        });
      }
      frameIds.add(frame.frameId);
      if (frame.firstOrdinal !== expectedFirstOrdinal) {
        fail(
          "frame_range_mismatch",
          `Frame ${frame.frameId} must start at ordinal ${expectedFirstOrdinal}; received ${frame.firstOrdinal}.`,
          { frameId: frame.frameId, ordinal: frame.firstOrdinal },
        );
      }

      const frameMessages = messagesByFrame.get(frame.frameId) ?? [];
      if (frameMessages.length === 0) {
        fail("frame_range_mismatch", `Frame ${frame.frameId} is empty.`, {
          frameId: frame.frameId,
        });
      }
      const actualLast = requireItem(
        frameMessages,
        frameMessages.length - 1,
        "frame message",
      ).ordinal;
      if (frame.state === "open") {
        if (
          options.allowOpenTail !== true ||
          index !== view.frames.length - 1 ||
          frame.lastOrdinal !== undefined ||
          openFrame !== undefined
        ) {
          fail("open_frame", `Frame ${frame.frameId} is open.`, {
            frameId: frame.frameId,
          });
        }
        openFrame = frame;
      } else if (frame.lastOrdinal !== actualLast) {
        fail(
          "frame_range_mismatch",
          `Frame ${frame.frameId} ends at ${String(frame.lastOrdinal)}, but its messages end at ${actualLast}.`,
          { frameId: frame.frameId, ordinal: actualLast },
        );
      }
      if (frameMessages[0]?.ordinal !== frame.firstOrdinal) {
        fail(
          "frame_range_mismatch",
          `Frame ${frame.frameId} does not own its declared first message.`,
          { frameId: frame.frameId, ordinal: frame.firstOrdinal },
        );
      }

      validateFrame({
        frame,
        frameMessages,
        seenToolCallIds,
        usedResultCallIds,
        resultsByCallId,
        fullIntegrity: options.fullIntegrity === true,
      });
      expectedFirstOrdinal = actualLast + 1;
    }

    if (expectedFirstOrdinal !== view.messages.length + 1) {
      fail(
        "frame_range_mismatch",
        "Protocol frames do not cover every message ordinal.",
      );
    }
    for (const frameId of messagesByFrame.keys()) {
      if (!frameIds.has(frameId)) {
        const message = messagesByFrame.get(frameId)?.[0];
        fail(
          "frame_range_mismatch",
          `Message references unknown frame ${frameId}.`,
          message === undefined ? {} : identityForMessage(message),
        );
      }
    }
    for (const result of view.toolResults) {
      if (!usedResultCallIds.has(result.toolCallId)) {
        fail(
          "tool_result_mismatch",
          `Tool result ${result.toolCallId} is not referenced by a tool message.`,
          { frameId: result.frameId, toolCallId: result.toolCallId },
        );
      }
    }
  }
}

type ValidateFrameInput = {
  frame: ProtocolFrame;
  frameMessages: readonly CanonicalMessageRecord[];
  seenToolCallIds: Set<string>;
  usedResultCallIds: Set<string>;
  resultsByCallId: Map<string, ToolResultRecord[]>;
  fullIntegrity: boolean;
};

function validateFrame(input: ValidateFrameInput): void {
  const { frame, frameMessages } = input;
  const first = requireItem(frameMessages, 0, "frame message");
  switch (frame.kind) {
    case "system":
      if (
        frame.firstOrdinal !== 1 ||
        frameMessages.length !== 1 ||
        first.role !== "system"
      ) {
        fail("invalid_system_frame", `Invalid system frame ${frame.frameId}.`, {
          ...identityForMessage(first),
        });
      }
      return;
    case "user":
      if (
        frameMessages.length !== 1 ||
        first.role !== "user" ||
        first.turnId !== frame.turnId
      ) {
        fail("invalid_user_frame", `Invalid user frame ${frame.frameId}.`, {
          ...identityForMessage(first),
        });
      }
      return;
    case "assistant_text":
      if (
        frameMessages.length !== 1 ||
        first.role !== "assistant" ||
        first.turnId !== frame.turnId ||
        first.iterationId !== frame.iterationId ||
        (first.toolCalls?.length ?? 0) !== 0 ||
        first.content === null ||
        first.content.trim() === ""
      ) {
        fail(
          "invalid_assistant_frame",
          `Invalid assistant text frame ${frame.frameId}.`,
          identityForMessage(first),
        );
      }
      return;
    case "tool_exchange":
      validateToolExchange(input, first);
  }
}

function validateToolExchange(
  input: ValidateFrameInput,
  assistant: CanonicalMessageRecord,
): void {
  const { frame, frameMessages } = input;
  if (
    assistant.role !== "assistant" ||
    assistant.turnId !== frame.turnId ||
    assistant.iterationId !== frame.iterationId ||
    assistant.toolCalls === undefined ||
    assistant.toolCalls.length === 0
  ) {
    fail(
      "invalid_assistant_frame",
      `Tool exchange ${frame.frameId} must begin with an assistant tool call message.`,
      identityForMessage(assistant),
    );
  }

  const providerIds = new Set<string>();
  for (let index = 0; index < assistant.toolCalls.length; index += 1) {
    const call = requireItem(assistant.toolCalls, index, "tool call");
    if (
      call.sessionId !== frame.sessionId ||
      call.turnId !== frame.turnId ||
      call.iterationId !== frame.iterationId ||
      call.toolCallNumber !== index + 1
    ) {
      fail(
        "tool_message_identity_mismatch",
        `Tool call ${call.toolCallId} has invalid frame identity or number.`,
        { frameId: frame.frameId, toolCallId: call.toolCallId },
      );
    }
    if (input.seenToolCallIds.has(call.toolCallId)) {
      fail("duplicate_tool_call_id", `Duplicate tool call ID ${call.toolCallId}.`, {
        frameId: frame.frameId,
        toolCallId: call.toolCallId,
      });
    }
    input.seenToolCallIds.add(call.toolCallId);
    if (
      call.providerToolCallId.trim() === "" ||
      providerIds.has(call.providerToolCallId)
    ) {
      fail(
        "duplicate_provider_tool_call_id",
        `Provider tool call ID must be non-empty and unique in frame ${frame.frameId}.`,
        { frameId: frame.frameId, toolCallId: call.toolCallId },
      );
    }
    providerIds.add(call.providerToolCallId);
  }

  const toolMessages = frameMessages.slice(1);
  if (toolMessages.length > assistant.toolCalls.length) {
    const extra = requireItem(toolMessages, assistant.toolCalls.length, "tool message");
    fail(
      "unexpected_tool_message",
      `Tool exchange ${frame.frameId} contains an unexpected tool message.`,
      identityForMessage(extra),
    );
  }
  if (frame.state === "closed" && toolMessages.length !== assistant.toolCalls.length) {
    const missing = assistant.toolCalls[toolMessages.length];
    fail(
      "missing_tool_message",
      `Tool exchange ${frame.frameId} is missing a tool message.`,
      { frameId: frame.frameId, toolCallId: missing?.toolCallId },
    );
  }

  for (let index = 0; index < toolMessages.length; index += 1) {
    const message = requireItem(toolMessages, index, "tool message");
    const call = requireItem(assistant.toolCalls, index, "tool call");
    if (message.role !== "tool") {
      fail(
        "unexpected_tool_message",
        `Expected a tool message at ordinal ${message.ordinal}.`,
        identityForMessage(message),
      );
    }
    if (message.toolCallId !== call.toolCallId) {
      fail(
        "tool_message_order_mismatch",
        `Tool message at ordinal ${message.ordinal} does not match call order.`,
        { ...identityForMessage(message), toolCallId: call.toolCallId },
      );
    }
    if (
      message.providerToolCallId !== call.providerToolCallId ||
      message.name !== call.name ||
      message.turnId !== frame.turnId ||
      message.iterationId !== frame.iterationId
    ) {
      fail(
        "tool_message_identity_mismatch",
        `Tool message ${message.messageId} does not match call ${call.toolCallId}.`,
        { ...identityForMessage(message), toolCallId: call.toolCallId },
      );
    }

    const results = input.resultsByCallId.get(call.toolCallId) ?? [];
    if (results.length === 0) {
      fail(
        "missing_tool_result",
        `Tool call ${call.toolCallId} has no result record.`,
        { ...identityForMessage(message), toolCallId: call.toolCallId },
      );
    }
    if (results.length !== 1) {
      fail(
        "tool_result_mismatch",
        `Tool call ${call.toolCallId} has ${results.length} result records.`,
        { ...identityForMessage(message), toolCallId: call.toolCallId },
      );
    }
    const result = requireItem(results, 0, "tool result");
    validateToolResultContent(message.content);
    if (message.displayText !== toolResultDisplayText(message.content)) {
      fail(
        "content_hash_mismatch",
        `Tool display projection does not match message ${message.messageId}.`,
        identityForMessage(message),
      );
    }
    if (
      result.sessionId !== frame.sessionId ||
      result.frameId !== frame.frameId ||
      result.toolMessageId !== message.messageId ||
      result.observationSha256 !== canonicalToolResultContentHash(message.content)
    ) {
      fail(
        "tool_result_mismatch",
        `Tool result for ${call.toolCallId} does not match its message.`,
        { ...identityForMessage(message), toolCallId: call.toolCallId },
      );
    }
    if (
      input.fullIntegrity &&
      result.completion.kind === "returned" &&
      result.completion.rawSha256 !== rawResultHash(result.completion.raw)
    ) {
      fail(
        "raw_hash_mismatch",
        `Raw result hash does not match tool call ${call.toolCallId}.`,
        { ...identityForMessage(message), toolCallId: call.toolCallId },
      );
    }
    if (input.fullIntegrity && result.completion.kind === "returned") {
      try {
        validateReturnedToolObservation({
          toolName: message.name,
          raw: result.completion.raw,
          content: message.content,
        });
      } catch (error) {
        fail(
          "tool_result_mismatch",
          `Tool result for ${call.toolCallId} has invalid canonical content: ${error instanceof Error ? error.message : String(error)}`,
          { ...identityForMessage(message), toolCallId: call.toolCallId },
        );
      }
    }
    input.usedResultCallIds.add(call.toolCallId);
  }
}

function groupResults(
  results: readonly ToolResultRecord[],
): Map<string, ToolResultRecord[]> {
  const grouped = new Map<string, ToolResultRecord[]>();
  for (const result of results) {
    const group = grouped.get(result.toolCallId) ?? [];
    group.push(result);
    grouped.set(result.toolCallId, group);
  }
  return grouped;
}

function identityForMessage(message: CanonicalMessageRecord): {
  frameId: ProtocolFrameId;
  messageId: MessageId;
  ordinal: number;
} {
  return {
    frameId: message.frameId,
    messageId: message.messageId,
    ordinal: message.ordinal,
  };
}

function requireItem<T>(items: readonly T[], index: number, name: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Missing ${name} at index ${index}.`);
  }
  return item;
}

function fail(
  code: ContextProtocolErrorCode,
  message: string,
  identity?: ConstructorParameters<typeof ContextProtocolError>[2],
): never {
  throw new ContextProtocolError(code, message, identity);
}
