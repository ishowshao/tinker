import type { ModelRequestInput } from "../model/model-client";
import type { ToolDefinition } from "../tools/types";
import { ContextBuilder } from "./context-builder";
import type { AgentMessage, AssistantMessage, ToolMessage } from "./types";

export type SessionConversation = {
  beginTurn(userPrompt: string): PendingTurnConversation;
  committedMessageCount(): number;
};

export type PendingTurnConversation = {
  readonly agent: AgentTurnConversation;
  projectedMessageCount(): number;
  commit(): void;
  discard(): void;
};

export type AgentTurnConversation = {
  appendAssistant(message: AssistantMessage): void;
  appendTool(message: ToolMessage): void;
  buildModelRequest(tools: ToolDefinition[]): ModelRequestInput;
};

type PendingState = "open" | "committed" | "discarded";

export class InMemorySessionConversation implements SessionConversation {
  private readonly committed: AgentMessage[];
  private pending?: InMemoryPendingTurn;

  constructor(
    systemPrompt: string,
    private readonly contextBuilder = new ContextBuilder(),
  ) {
    if (systemPrompt.trim() === "") {
      throw new Error("Session conversation system prompt must not be empty.");
    }
    this.committed = [{ role: "system", content: systemPrompt }];
  }

  beginTurn(userPrompt: string): PendingTurnConversation {
    if (userPrompt.trim() === "") {
      throw new Error("Cannot begin a conversation turn with an empty prompt.");
    }
    if (this.pending !== undefined) {
      throw new Error("Cannot begin a conversation turn while another turn is open.");
    }

    const pending = new InMemoryPendingTurn(
      this.committed,
      userPrompt,
      this.contextBuilder,
      (state) => {
        if (this.pending !== pending) {
          throw new Error("Conversation pending turn ownership was lost.");
        }
        if (state === "committed") {
          this.committed.push(...pending.deltaSnapshot());
        }
        this.pending = undefined;
      },
    );
    this.pending = pending;
    return pending;
  }

  committedMessageCount(): number {
    return this.committed.length;
  }

  snapshot(): AgentMessage[] {
    return [...this.committed];
  }
}

class InMemoryPendingTurn implements PendingTurnConversation {
  readonly agent: AgentTurnConversation;
  private readonly delta: AgentMessage[];
  private state: PendingState = "open";

  constructor(
    private readonly committed: AgentMessage[],
    userPrompt: string,
    private readonly contextBuilder: ContextBuilder,
    private readonly settleOwner: (state: "committed" | "discarded") => void,
  ) {
    this.delta = [{ role: "user", content: userPrompt }];
    this.agent = {
      appendAssistant: (message) => this.append(message),
      appendTool: (message) => this.append(message),
      buildModelRequest: (tools) => this.buildModelRequest(tools),
    };
  }

  projectedMessageCount(): number {
    this.requireOpen("read projected message count");
    return this.committed.length + this.delta.length;
  }

  commit(): void {
    this.settle("committed");
  }

  discard(): void {
    this.settle("discarded");
  }

  deltaSnapshot(): AgentMessage[] {
    if (this.state !== "committed") {
      throw new Error("Cannot read a pending turn delta before commit.");
    }
    return [...this.delta];
  }

  private append(message: AssistantMessage | ToolMessage): void {
    this.requireOpen("append a message");
    this.delta.push(message);
  }

  private buildModelRequest(tools: ToolDefinition[]): ModelRequestInput {
    this.requireOpen("build a model request");
    return this.contextBuilder.build({
      messages: [...this.committed, ...this.delta],
      tools,
    });
  }

  private settle(state: "committed" | "discarded"): void {
    this.requireOpen(state === "committed" ? "commit" : "discard");
    this.state = state;
    this.settleOwner(state);
  }

  private requireOpen(action: string): void {
    if (this.state !== "open") {
      throw new Error(`Cannot ${action} after pending turn was ${this.state}.`);
    }
  }
}
