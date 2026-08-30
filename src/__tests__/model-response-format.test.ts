import { describe, expect, test } from "bun:test";
import type { ModelRequestInput } from "../model/model-client";
import { FakeModelClient } from "../model/fake-model-client";
import { OpenAIChatModelClient } from "../model/openai-chat-model-client";
import { OpenAIResponsesModelClient } from "../model/openai-responses-model-client";
import { TEST_CONTEXT_BUDGET } from "./test-runtime";

const INPUT: ModelRequestInput = {
  messages: [
    { role: "system", content: "kernel" },
    { role: "user", content: "hello" },
  ],
  tools: [],
};

const JSON_MODE_INPUT: ModelRequestInput = {
  ...INPUT,
  responseFormat: { type: "json_object" },
};

function stubFetch(): typeof fetch {
  return Object.assign(async () => new Response(), {
    preconnect() {},
  });
}

function chatClient() {
  return new OpenAIChatModelClient({
    apiKey: "test-key",
    model: "test-model",
    contextBudget: TEST_CONTEXT_BUDGET,
    fetch: stubFetch(),
  });
}

function responsesClient() {
  return new OpenAIResponsesModelClient({
    apiKey: "test-key",
    model: "test-model",
    contextBudget: TEST_CONTEXT_BUDGET,
    fetch: stubFetch(),
  });
}

describe("ModelRequestInput responseFormat", () => {
  test("OpenAI chat prepare maps JSON mode to response_format", () => {
    const client = chatClient();
    const plain = client.prepare(INPUT);
    const jsonMode = client.prepare(JSON_MODE_INPUT);

    expect(plain.payload).not.toHaveProperty("response_format");
    expect(jsonMode.payload).toMatchObject({
      response_format: { type: "json_object" },
    });
    expect(jsonMode.requestConfigHash).not.toBe(plain.requestConfigHash);
  });

  test("OpenAI responses prepare maps JSON mode to text.format", () => {
    const client = responsesClient();
    const plain = client.prepare(INPUT);
    const jsonMode = client.prepare(JSON_MODE_INPUT);

    expect(plain.payload).not.toHaveProperty("text");
    expect(jsonMode.payload).toMatchObject({
      text: { format: { type: "json_object" } },
    });
    expect(jsonMode.requestConfigHash).not.toBe(plain.requestConfigHash);
  });

  test("fake client echoes responseFormat in the payload for parity", () => {
    const client = new FakeModelClient("test-mode", {
      model: "test-model",
      contextBudget: TEST_CONTEXT_BUDGET,
    });
    const plain = client.prepare(INPUT);
    const jsonMode = client.prepare(JSON_MODE_INPUT);

    expect(plain.payload).not.toHaveProperty("responseFormat");
    expect(jsonMode.payload).toMatchObject({
      responseFormat: { type: "json_object" },
    });
    expect(jsonMode.requestConfigHash).not.toBe(plain.requestConfigHash);
  });
});
