import { RuntimeReasoningEffort } from "../../model/reasoning-effort";
import type {
  ModelRequestOptions,
  PreparedModelRequest,
} from "../../model/model-client";
import {
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "../test-runtime";
export const catalog = {
  defaultProfile: "small",
  profiles: [
    {
      name: "small",
      model: "small-model",
      contextWindowTokens: 262144,
      maxSupportedOutputTokens: 65536,
    },
    {
      name: "large",
      model: "large-model",
      contextWindowTokens: 262144,
      maxSupportedOutputTokens: 65536,
    },
  ],
};
export class CapabilityModel extends TestModelClient {
  readonly reasoningEffort = new RuntimeReasoningEffort({
    supportedEfforts: ["low", "high"],
    defaultEffort: "low",
  });
  inputs: string[] = [];
  constructor(private readonly write = false) {
    super();
  }
  async request(prepared: PreparedModelRequest, options: ModelRequestOptions) {
    this.inputs.push(JSON.stringify(testModelRequestInput(prepared).messages));
    const identity = options.identity!;
    return testModelOutput(
      prepared,
      this.write && this.inputs.length <= 2
        ? {
            role: "assistant",
            toolCalls: [
              {
                ...identity.runtimeSession.createToolCall(identity.iteration, 1),
                providerToolCallId: "write",
                name: this.inputs.length === 1 ? "Read" : "Write",
                args:
                  this.inputs.length === 1
                    ? { file_path: "target.txt" }
                    : { file_path: "target.txt", content: "after" },
              },
            ],
          }
        : { role: "assistant", content: "CAPABILITY_DONE" },
    );
  }
}
