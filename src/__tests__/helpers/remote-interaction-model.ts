import {
  ProviderResponseError,
  type ModelRequestOptions,
  type PreparedModelRequest,
} from "../../model/model-client";
import {
  TestModelClient,
  testModelOutput,
  testModelRequestInput,
} from "../test-runtime";

export class RemoteInteractionModel extends TestModelClient {
  readonly requests: { input: string; iterationId: string | undefined }[] = [];
  constructor(
    readonly mode: "question" | "confirmation" | "retry",
    private readonly rounds = 2,
  ) {
    super();
  }
  async request(prepared: PreparedModelRequest, options: ModelRequestOptions) {
    this.requests.push({
      input: JSON.stringify(testModelRequestInput(prepared).messages),
      iterationId: options.identity?.iteration.iterationId,
    });
    const number = this.requests.length;
    if (this.mode === "retry" && number <= this.rounds + 2)
      throw new ProviderResponseError(
        "reasoning_only_assistant",
        `REMOTE_RETRY_FAILURE_${number}`,
        { provider: "test", model: "test-model" },
      );
    // Bash guard sees the unreachable power command; allowing only writes a temporary marker.
    if (this.mode !== "retry" && number <= this.rounds) {
      const identity = options.identity!;
      return testModelOutput(prepared, {
        role: "assistant",
        toolCalls: [
          {
            ...identity.runtimeSession.createToolCall(identity.iteration, 1),
            providerToolCallId: `interaction-${number}`,
            name: this.mode === "question" ? "AskUser" : "Bash",
            args:
              this.mode === "question"
                ? {
                    question: "REMOTE_SAME_QUESTION",
                    options: [
                      { description: "First choice" },
                      { description: "Second choice" },
                    ],
                  }
                : { command: "false && reboot; printf allowed > guarded-target" },
          },
        ],
      });
    }
    return testModelOutput(prepared, {
      role: "assistant",
      content: "REMOTE_INTERACTION_DONE",
    });
  }
}
