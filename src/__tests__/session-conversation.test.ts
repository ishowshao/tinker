import { describe, expect, test } from "bun:test";
import { InMemorySessionConversation } from "../agent/session-conversation";

describe("InMemorySessionConversation", () => {
  test("materializes committed history plus the open turn without exposing its array", () => {
    const conversation = new InMemorySessionConversation("system");
    const first = conversation.beginTurn("first");

    const request = first.agent.buildModelRequest([]);
    expect(request.messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "first" },
    ]);

    request.messages.push({ role: "user", content: "adapter mutation" });
    expect(first.projectedMessageCount()).toBe(2);
    expect(first.agent.buildModelRequest([]).messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "first" },
    ]);
  });

  test("commits a turn delta and keeps the system message unique", () => {
    const conversation = new InMemorySessionConversation("system");
    const first = conversation.beginTurn("first");
    first.agent.appendAssistant({ role: "assistant", content: "answer" });

    expect(first.projectedMessageCount()).toBe(3);
    first.commit();

    const second = conversation.beginTurn("second");
    expect(second.agent.buildModelRequest([]).messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ]);
  });

  test("discards a turn delta without advancing committed history", () => {
    const conversation = new InMemorySessionConversation("system");
    const discarded = conversation.beginTurn("discard me");
    discarded.agent.appendAssistant({ role: "assistant", content: "temporary" });
    discarded.discard();

    expect(conversation.committedMessageCount()).toBe(1);
    expect(conversation.snapshot()).toEqual([{ role: "system", content: "system" }]);

    const next = conversation.beginTurn("kept");
    expect(next.agent.buildModelRequest([]).messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "kept" },
    ]);
  });

  test("fast-fails concurrent turns and use after terminal settlement", () => {
    const conversation = new InMemorySessionConversation("system");
    const pending = conversation.beginTurn("first");

    expect(() => conversation.beginTurn("second")).toThrow("another turn is open");

    pending.commit();
    expect(() => pending.commit()).toThrow("after pending turn was committed");
    expect(() =>
      pending.agent.appendAssistant({ role: "assistant", content: "late" }),
    ).toThrow("after pending turn was committed");

    const discarded = conversation.beginTurn("third");
    discarded.discard();
    expect(() => discarded.discard()).toThrow("after pending turn was discarded");
  });

  test("fast-fails empty system and user prompts", () => {
    expect(() => new InMemorySessionConversation("  ")).toThrow(
      "system prompt must not be empty",
    );

    const conversation = new InMemorySessionConversation("system");
    expect(() => conversation.beginTurn("  ")).toThrow("empty prompt");
  });
});
