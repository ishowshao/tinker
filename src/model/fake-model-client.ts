import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import type { AgentMessage, AssistantMessage } from "../agent/types";
import { toolResultDisplayText } from "../agent/tool-result-content";
import { cancellationError } from "../agent/turn-cancellation";
import {
  IMAGE_INPUT_POLICY,
  imagePlanningTokens,
  providerImageDimensions,
} from "../image/image-input-policy";
import type { ImageAssetId, ImageAssetRef } from "../image/image-types";
import { materializeProviderImage } from "../image/provider-image";
import type { ModelContextBudget } from "./model-context-profile";
import type { ReasoningEffortController } from "./reasoning-effort";
import type {
  MaterializedModelRequest,
  ModelClient,
  ModelMaterializeOptions,
  ModelMessageProtocol,
  ModelRequestInput,
  ModelRequestOptions,
  ModelRequestOutput,
  PreparedMediaOccurrence,
  PreparedModelRequest,
  PreparedPromptSegment,
} from "./model-client";
import { validateModelModalities } from "./model-client";
import { sha256, stableJsonStringify } from "./model-request-preflight";
import { estimatePromptSegments } from "./token-estimator";

export class FakeModelClient implements ModelClient {
  readonly inputModalities: readonly ("text" | "image")[];
  readonly toolResultModalities: readonly ("text" | "image")[];
  readonly reasoningEffort?: ReasoningEffortController;
  readonly messageProtocol: ModelMessageProtocol = Object.freeze({
    adapter: "fake",
    serializationVersion: "fake-v1",
  });
  private steps = 0;
  private readonly preparedInputs = new WeakMap<object, ModelRequestInput>();
  private readonly materializedRequests = new WeakSet<object>();

  constructor(
    private readonly mode: string,
    private readonly options: {
      model: string;
      contextBudget: ModelContextBudget;
      inputModalities?: readonly ("text" | "image")[];
      toolResultModalities?: readonly ("text" | "image")[];
      reasoningEffort?: ReasoningEffortController;
      requestLogPath?: string;
    },
  ) {
    this.reasoningEffort = options.reasoningEffort;
    const modalities = validateModelModalities({
      adapter: this.messageProtocol.adapter,
      inputModalities: options.inputModalities ?? ["text"],
      toolResultModalities: options.toolResultModalities ?? ["text"],
      adapterToolResultModalities: ["text", "image"],
    });
    this.inputModalities = modalities.inputModalities;
    this.toolResultModalities = modalities.toolResultModalities;
  }

  prepare(input: ModelRequestInput): PreparedModelRequest {
    const toolSegments = input.tools.map(
      (tool): PreparedPromptSegment => ({
        kind: "tool_schema",
        normalizedText: stableJsonStringify(tool),
      }),
    );
    const messageSegments = input.messages.map((message, index) =>
      toPromptSegment(message, index + 1),
    );
    const mediaOccurrenceCount = messageSegments.reduce(
      (total, segment) => total + (segment.media?.length ?? 0),
      0,
    );
    const reasoningEffort = this.reasoningEffort?.snapshot().effort;
    const requestConfigHash = sha256(
      stableJsonStringify({
        adapter: this.messageProtocol.adapter,
        serializationVersion: this.messageProtocol.serializationVersion,
        mode: this.mode,
        model: this.options.model,
        requestMaxOutputTokens: this.options.contextBudget.requestMaxOutputTokens,
        inputModalities: this.inputModalities,
        toolResultModalities: this.toolResultModalities,
      }),
    );
    const prepared: PreparedModelRequest = Object.freeze({
      provider: "fake",
      model: this.options.model,
      payload: Object.freeze({
        messages: Object.freeze([...input.messages]),
        tools: Object.freeze([...input.tools]),
        maxTokens: this.options.contextBudget.requestMaxOutputTokens,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      }),
      promptSegments: Object.freeze([...toolSegments, ...messageSegments]),
      requestConfigHash,
      toolSchemaHash: sha256(
        toolSegments.map((segment) => segment.normalizedText).join("\n"),
      ),
      requestMaxOutputTokens: this.options.contextBudget.requestMaxOutputTokens,
      mediaOccurrenceCount,
      assistantReplaySegments: (message: AssistantMessage) => [
        toPromptSegment(message),
      ],
    });
    this.preparedInputs.set(prepared, {
      messages: [...input.messages],
      tools: [...input.tools],
    });
    return prepared;
  }

  async materialize(
    prepared: PreparedModelRequest,
    options: ModelMaterializeOptions,
  ): Promise<MaterializedModelRequest> {
    const input = this.preparedInputs.get(prepared);
    if (input === undefined) {
      throw new Error("Fake model request was not prepared by this client.");
    }
    options.signal.throwIfAborted();
    if (prepared.mediaOccurrenceCount > IMAGE_INPUT_POLICY.maxImagesPerRequest) {
      throw new Error(
        `Fake model request has ${prepared.mediaOccurrenceCount} images; maximum is ${IMAGE_INPUT_POLICY.maxImagesPerRequest}.`,
      );
    }
    if (prepared.mediaOccurrenceCount > 0 && !this.inputModalities.includes("image")) {
      throw new Error("Current fake model profile does not support image input.");
    }

    const assets = distinctPreparedAssets(prepared.promptSegments);
    const materializedAssets: Array<{
      readonly assetId: ImageAssetId;
      readonly byteLength: number;
      readonly width: number;
      readonly height: number;
      readonly planningTokens: number;
      readonly bytesSha256: string;
    }> = [];
    for (const asset of assets.values()) {
      options.signal.throwIfAborted();
      const bytes = await options.assetStore.readVerified(asset, {
        signal: options.signal,
      });
      const image = await materializeProviderImage(bytes, asset.mimeType);
      materializedAssets.push(
        Object.freeze({
          assetId: asset.assetId,
          byteLength: image.bytes.byteLength,
          width: image.width,
          height: image.height,
          planningTokens: image.planningTokens,
          bytesSha256: createHash("sha256").update(image.bytes).digest("hex"),
        }),
      );
    }
    options.signal.throwIfAborted();

    const payload = Object.freeze({
      ...(prepared.payload as Record<string, unknown>),
      materializedAssets: Object.freeze(materializedAssets),
    });
    const materialized = Object.freeze({
      ...prepared,
      payload,
      promptSegments: materializedFakePromptSegments(
        prepared.promptSegments,
        materializedAssets,
      ),
      bodyBytes: Buffer.byteLength(stableJsonStringify(payload), "utf8"),
    });
    this.preparedInputs.set(materialized, input);
    this.materializedRequests.add(materialized);
    return materialized;
  }

  async request(
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    const input = this.preparedInputs.get(prepared);
    if (input === undefined) {
      throw new Error("Fake model request was not prepared by this client.");
    }
    this.steps += 1;
    if (this.options.requestLogPath !== undefined) {
      await appendFile(
        this.options.requestLogPath,
        `${stableJsonStringify({
          mode: this.mode,
          model: this.options.model,
          prompt: lastUserMessage(input.messages),
          ...(this.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: this.reasoningEffort.snapshot().effort }),
          requestNumber: this.steps,
        })}\n`,
        "utf8",
      );
    }

    if (this.mode === "write-notes") {
      return this.writeNotes(input, prepared, options);
    }
    if (this.mode === "wait-for-cancel") {
      return waitForCancellation(options.signal);
    }
    if (this.mode === "recall-smoke") {
      return this.recallSmoke(input, prepared, options);
    }
    if (this.mode === "pty-echo-history") {
      return this.ptyEchoHistory(input, prepared);
    }
    if (this.mode === "pty-static-history") {
      return this.ptyStaticHistory(input, prepared, options);
    }
    if (this.mode === "pty-incremental-output") {
      return this.ptyIncrementalOutput(input, prepared, options);
    }
    if (this.mode === "pty-steering-notice") {
      return this.ptySteeringNotice(input, prepared, options);
    }
    if (this.mode === "pty-resume-layout") {
      return this.ptyResumeLayout(input, prepared, options);
    }
    if (this.mode === "pty-cancel-then-echo") {
      return this.ptyCancelThenEcho(input, prepared, options);
    }
    if (this.mode === "pty-tool-chain") {
      return this.ptyToolChain(input, prepared, options);
    }
    if (this.mode === "pty-turn-undo") {
      return this.ptyTurnUndo(input, prepared, options);
    }
    if (this.mode === "pty-background-task") {
      return this.ptyBackgroundTask(input, prepared, options);
    }
    if (this.mode === "pty-interactive-terminal") {
      return this.ptyInteractiveTerminal(input, prepared, options);
    }
    if (this.mode === "pty-resume") {
      return this.ptyResume(input, prepared, options);
    }
    if (this.mode === "pty-interrupted-tool") {
      return this.ptyInterruptedTool(input, prepared, options);
    }
    if (this.mode === "pty-fail-once") {
      return this.ptyFailOnce(input, prepared);
    }
    if (this.mode === "pty-prompt-input") {
      return this.ptyPromptInput(input, prepared);
    }
    if (this.mode === "pty-file-command") {
      return this.ptyFileCommand(input, prepared);
    }
    if (this.mode === "pty-clear") {
      return this.ptyClear(input, prepared);
    }
    if (this.mode === "pty-fork") {
      return this.ptyFork(input, prepared, options);
    }
    if (this.mode === "pty-model-switch") {
      return this.ptyModelSwitch(input, prepared);
    }
    if (this.mode === "pty-viewer") {
      return this.ptyViewer(input, prepared);
    }
    if (this.mode === "pty-copy") {
      return this.ptyCopy(input, prepared);
    }
    if (this.mode === "pty-context-heavy") {
      return this.ptyContextHeavy(input, prepared, options);
    }
    if (this.mode === "pty-image") {
      return this.ptyImage(input, prepared);
    }
    if (this.mode === "pty-local-panels") {
      return this.ptyLocalPanels(input, prepared);
    }
    if (this.mode === "pty-skill-activate") {
      return this.ptySkillActivate(input, prepared, options);
    }
    if (this.mode === "pty-mcp-call") {
      return this.ptyMcpCall(input, prepared, options);
    }

    return outputWithUsage(
      prepared,
      {
        role: "assistant",
        content: `Fake model received: ${lastUserMessage(input.messages)}`,
      },
      "stop",
    );
  }

  private ptyEchoHistory(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
  ): ModelRequestOutput {
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_FIRST") {
      return textOutput(prepared, "PTY_TURN_ONE_DONE");
    }
    if (prompt === "PTY_SECOND") {
      requireMessage(input.messages, "user", "PTY_FIRST");
      requireMessage(input.messages, "assistant", "PTY_TURN_ONE_DONE");
      return textOutput(prepared, "PTY_TURN_TWO_DONE");
    }
    throw new Error(`Unexpected pty-echo-history prompt: ${JSON.stringify(prompt)}.`);
  }

  private async ptyStaticHistory(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    const prompt = lastUserMessage(input.messages);
    const historyMatch = /^PTY_STATIC_HISTORY_([1-4])$/u.exec(prompt);
    if (historyMatch !== null) {
      const turn = historyMatch[1];
      return textOutput(
        prepared,
        [
          turn === "1"
            ? "PTY_STATIC_HISTORY_EARLY_SENTINEL"
            : `PTY_STATIC_HISTORY_${turn}`,
          ...Array.from(
            { length: 8 },
            (_, index) => `- settled PTY history ${turn}.${index + 1}`,
          ),
          `PTY_STATIC_HISTORY_${turn}_DONE`,
        ].join("\n"),
      );
    }
    if (prompt !== "PTY_STATIC_LIVE") {
      throw new Error(
        `Unexpected pty-static-history prompt: ${JSON.stringify(prompt)}.`,
      );
    }

    requireTools(input, ["Bash"]);
    const bash = toolMessagesAfterLastUser(input.messages).find(
      (message) => message.name === "Bash",
    );
    await Bun.sleep(200);
    options.signal.throwIfAborted();
    if (bash === undefined) {
      return toolCallOutput(prepared, options, "Bash", {
        command:
          'index=1; while [ "$index" -le 20 ]; do printf \'PTY_STATIC_LIVE_LINE_%s\\n\' "$index"; index=$((index + 1)); done; sleep 0.2',
        description: "Exercise static history live tail",
      });
    }
    if (!toolMessageText(bash).includes("PTY_STATIC_LIVE_LINE_20")) {
      throw new Error("PTY static-history Bash output was incomplete.");
    }
    return textOutput(prepared, "PTY_STATIC_LIVE_DONE");
  }

  private async ptyIncrementalOutput(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    const prompt = lastUserMessage(input.messages);
    if (prompt !== "PTY_INCREMENTAL_OUTPUT") {
      throw new Error(
        `Unexpected pty-incremental-output prompt: ${JSON.stringify(prompt)}.`,
      );
    }

    const chunks = [
      "## PTY incremental first\nPTY_INCREMENTAL_EARLY_SENTINEL\n\n## PTY incre",
      "mental second\n",
      "PTY_INCREMENTAL_SECOND_BODY\n\n## PTY incremental final\n",
      "PTY_INCREMENTAL_FINAL_SENTINEL",
    ] as const;
    options.onTextDelta?.(chunks[0]);
    await Bun.sleep(50);
    options.signal.throwIfAborted();
    options.onTextDelta?.(chunks[1]);
    await Bun.sleep(700);
    options.signal.throwIfAborted();
    options.onTextDelta?.(chunks[2]);
    await Bun.sleep(100);
    options.signal.throwIfAborted();
    options.onTextDelta?.(chunks[3]);
    await Bun.sleep(100);
    options.signal.throwIfAborted();
    return textOutput(prepared, chunks.join(""));
  }

  private async ptySteeringNotice(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> {
    requireTools(input, ["Bash"]);
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_STEERING_START") {
      await Bun.sleep(600);
      options.signal.throwIfAborted();
      return toolCallOutput(prepared, options, "Bash", {
        command: "printf 'PTY_STEERING_TOOL_DONE\\n'",
        description: "Create steering boundary",
      });
    }
    if (prompt === "PTY_STEERING_FOLLOWUP") {
      requireToolMessage(input.messages, "Bash", "PTY_STEERING_TOOL_DONE");
      await Bun.sleep(1_500);
      options.signal.throwIfAborted();
      return textOutput(prepared, "PTY_STEERING_FINAL");
    }
    throw new Error(
      `Unexpected pty-steering-notice prompt: ${JSON.stringify(prompt)}.`,
    );
  }

  private ptyResumeLayout(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    const prompt = lastUserMessage(input.messages);
    if (/^PTY_RESUME_LAYOUT_PAD_\d+$/u.test(prompt)) {
      return textOutput(prepared, `${prompt}_DONE`);
    }
    const match = /^PTY_RESUME_LAYOUT_([1-3])$/u.exec(prompt);
    if (match === null) {
      throw new Error(
        `Unexpected pty-resume-layout prompt: ${JSON.stringify(prompt)}.`,
      );
    }

    requireTools(input, ["Read"]);
    const turn = Number(match[1]);
    const targetToolCount = [8, 17, 4][turn - 1];
    const finalLineCount = [31, 47, 8][turn - 1];
    if (targetToolCount === undefined || finalLineCount === undefined) {
      throw new Error(`Invalid pty-resume-layout turn: ${turn}.`);
    }

    const completedReads = toolMessagesAfterLastUser(input.messages).filter(
      (message) => message.name === "Read",
    ).length;
    if (completedReads < targetToolCount) {
      return toolCallOutput(prepared, options, "Read", {
        file_path: "resume-layout.txt",
      });
    }

    return textOutput(
      prepared,
      Array.from(
        { length: finalLineCount },
        (_, index) =>
          `PTY_RESUME_LAYOUT_${turn}_FINAL_${String(index + 1).padStart(2, "0")}`,
      ).join("\n"),
    );
  }

  private ptyCancelThenEcho(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> | ModelRequestOutput {
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_CANCEL_BLOCK") {
      return waitForCancellation(options.signal);
    }
    if (prompt === "PTY_AFTER_CANCEL") {
      requireMessage(input.messages, "user", "PTY_CANCEL_BLOCK");
      return textOutput(prepared, "PTY_AFTER_CANCEL_DONE");
    }
    throw new Error(
      `Unexpected pty-cancel-then-echo prompt: ${JSON.stringify(prompt)}.`,
    );
  }

  private ptyToolChain(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    requireTools(input, ["Write", "Edit", "Bash"]);
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_TOOL_FAILURE") {
      const bash = toolMessagesAfterLastUser(input.messages).find(
        (message) => message.name === "Bash",
      );
      if (bash === undefined) {
        return toolCallOutput(prepared, options, "Bash", {
          command: "printf 'PTY_TOOL_FAILURE_OUTPUT\\n' >&2; exit 7",
          description: "Produce expected PTY failure",
        });
      }
      if (
        !toolMessageText(bash).includes("Bash failed") ||
        !toolMessageText(bash).includes("exitCode=7") ||
        !toolMessageText(bash).includes("PTY_TOOL_FAILURE_OUTPUT")
      ) {
        throw new Error("PTY Bash failure branch returned an unexpected result.");
      }
      return textOutput(prepared, "PTY_TOOL_FAILURE_HANDLED");
    }
    if (prompt === "PTY_AFTER_TOOL_FAILURE") {
      requireToolMessage(input.messages, "Bash", "exitCode=7");
      requireMessage(input.messages, "assistant", "PTY_TOOL_FAILURE_HANDLED");
      return textOutput(prepared, "PTY_AFTER_TOOL_FAILURE_DONE");
    }
    if (prompt === "PTY_TOOL_CHAIN_VERIFY") {
      requireToolMessage(input.messages, "Write", "Write succeeded");
      requireToolMessage(input.messages, "Edit", "Edit succeeded");
      requireToolMessage(input.messages, "Bash", "PTY_BASH_OK:beta");
      requireMessage(input.messages, "assistant", "PTY_TOOL_CHAIN_DONE");
      return textOutput(prepared, "PTY_TOOL_CHAIN_VERIFIED");
    }
    if (prompt !== "PTY_TOOL_CHAIN_START") {
      throw new Error(`Unexpected pty-tool-chain prompt: ${JSON.stringify(prompt)}.`);
    }

    const tools = toolMessagesAfterLastUser(input.messages);
    const write = tools.find((message) => message.name === "Write");
    if (write === undefined) {
      return toolCallOutput(prepared, options, "Write", {
        file_path: "pty-tool-chain.txt",
        content: "alpha\n",
      });
    }
    if (!toolMessageText(write).includes("Write succeeded")) {
      throw new Error("PTY Write tool did not succeed.");
    }

    const edit = tools.find((message) => message.name === "Edit");
    if (edit === undefined) {
      return toolCallOutput(prepared, options, "Edit", {
        file_path: "pty-tool-chain.txt",
        old_string: "alpha",
        new_string: "beta",
      });
    }
    if (!toolMessageText(edit).includes("Edit succeeded")) {
      throw new Error("PTY Edit tool did not succeed.");
    }

    const bash = tools.find((message) => message.name === "Bash");
    if (bash === undefined) {
      return toolCallOutput(prepared, options, "Bash", {
        command: "printf 'PTY_BASH_OK:%s\\n' \"$(cat pty-tool-chain.txt)\"",
        description: "Verify edited PTY fixture",
      });
    }
    if (
      !toolMessageText(bash).includes("Bash completed") ||
      !toolMessageText(bash).includes("PTY_BASH_OK:beta")
    ) {
      throw new Error("PTY Bash tool did not verify the edited file.");
    }
    return textOutput(prepared, "PTY_TOOL_CHAIN_DONE");
  }

  private ptyTurnUndo(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    requireTools(input, ["Read", "Write", "Delete"]);
    const prompt = lastUserMessage(input.messages);
    if (prompt !== "PTY_UNDO_MUTATE") {
      throw new Error(`Unexpected pty-turn-undo prompt: ${JSON.stringify(prompt)}.`);
    }

    const tools = toolMessagesAfterLastUser(input.messages);
    const read = tools.find((message) => message.name === "Read");
    if (read === undefined) {
      return toolCallOutput(prepared, options, "Read", {
        file_path: "pty-undo-modified.txt",
      });
    }
    if (!toolMessageText(read).includes("Read succeeded")) {
      throw new Error("PTY undo Read tool did not succeed.");
    }

    const writes = tools.filter((message) => message.name === "Write");
    if (writes.length === 0) {
      return toolCallOutput(prepared, options, "Write", {
        file_path: "pty-undo-modified.txt",
        content: "after undo turn\n",
      });
    }
    if (
      writes[0] === undefined ||
      !toolMessageText(writes[0]).includes("Write succeeded")
    ) {
      throw new Error("PTY undo modifying Write did not succeed.");
    }
    if (writes.length === 1) {
      return toolCallOutput(prepared, options, "Write", {
        file_path: "pty-undo-created/nested.txt",
        content: "created by undo turn\n",
      });
    }
    if (
      writes[1] === undefined ||
      !toolMessageText(writes[1]).includes("Write succeeded")
    ) {
      throw new Error("PTY undo creating Write did not succeed.");
    }

    const deletion = tools.find((message) => message.name === "Delete");
    if (deletion === undefined) {
      return toolCallOutput(prepared, options, "Delete", {
        file_path: "pty-undo-deleted.bin",
      });
    }
    if (!toolMessageText(deletion).includes("Delete succeeded")) {
      throw new Error("PTY undo Delete tool did not succeed.");
    }
    return textOutput(prepared, "PTY_UNDO_MUTATIONS_DONE");
  }

  private ptyBackgroundTask(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    requireTools(input, ["Bash", "TaskOutput", "TaskStop"]);
    const prompt = lastUserMessage(input.messages);
    if (prompt !== "PTY_BACKGROUND_STOP" && prompt !== "PTY_BACKGROUND_QUIT") {
      throw new Error(
        `Unexpected pty-background-task prompt: ${JSON.stringify(prompt)}.`,
      );
    }

    const tools = toolMessagesAfterLastUser(input.messages);
    const bash = tools.find((message) => message.name === "Bash");
    if (bash === undefined) {
      return toolCallOutput(prepared, options, "Bash", {
        command:
          "printf '%s\\n' \"$$\" > pty-background.pid; printf 'PTY_BACKGROUND_READY\\n'; while :; do sleep 1; done",
        description: "Run PTY background fixture",
        run_in_background: true,
      });
    }
    if (!toolMessageText(bash).includes("Bash command is running in background")) {
      throw new Error("PTY Bash task did not enter the background.");
    }
    const taskId = requireObservationValue(toolMessageText(bash), "taskId");

    if (prompt === "PTY_BACKGROUND_QUIT") {
      return textOutput(prepared, "PTY_BACKGROUND_RUNNING");
    }

    const outputs = tools.filter((message) => message.name === "TaskOutput");
    const output = outputs.at(-1);
    if (
      output === undefined ||
      !toolMessageText(output).includes("PTY_BACKGROUND_READY")
    ) {
      if (outputs.length >= 20) {
        throw new Error("PTY background task did not produce its ready marker.");
      }
      return toolCallOutput(prepared, options, "TaskOutput", {
        task_id: taskId,
      });
    }
    if (!toolMessageText(output).includes(`taskId=${taskId}`)) {
      throw new Error("PTY TaskOutput returned the wrong task.");
    }

    const stop = tools.find((message) => message.name === "TaskStop");
    if (stop === undefined) {
      return toolCallOutput(prepared, options, "TaskStop", {
        task_id: taskId,
      });
    }
    if (
      !toolMessageText(stop).includes(`taskId=${taskId}`) ||
      !toolMessageText(stop).includes("status=killed")
    ) {
      throw new Error("PTY TaskStop did not kill the background task.");
    }
    return textOutput(prepared, "PTY_BACKGROUND_STOPPED");
  }

  private ptyInteractiveTerminal(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    requireTools(input, ["Bash", "TaskOutput", "TaskInput"]);
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_INTERACTIVE_FOLLOWUP") {
      requireMessage(input.messages, "assistant", "PTY_INTERACTIVE_DONE");
      return textOutput(prepared, "PTY_INTERACTIVE_FOLLOWUP_DONE");
    }
    if (prompt !== "PTY_INTERACTIVE_TERMINAL" && prompt !== "PTY_INTERACTIVE_QUIT") {
      throw new Error(
        `Unexpected pty-interactive-terminal prompt: ${JSON.stringify(prompt)}.`,
      );
    }

    const tools = toolMessagesAfterLastUser(input.messages);
    const bash = tools.find((message) => message.name === "Bash");
    if (bash === undefined) {
      return toolCallOutput(prepared, options, "Bash", {
        command: "python3 -q",
        description: "Start interactive Python fixture",
        tty: true,
        timeout: 25,
      });
    }
    if (
      !toolMessageText(bash).includes("taskId=") ||
      !toolMessageText(bash).includes("tty=true")
    ) {
      throw new Error("PTY Bash task did not return an interactive task ID.");
    }
    const taskId = requireObservationValue(toolMessageText(bash), "taskId");

    const outputs = tools.filter((message) => message.name === "TaskOutput");
    const output = outputs.at(-1);
    if (output === undefined || !toolMessageText(output).includes(">>>")) {
      if (outputs.length >= 20) {
        throw new Error("Interactive Python fixture did not show its prompt.");
      }
      return toolCallOutput(prepared, options, "TaskOutput", {
        task_id: taskId,
      });
    }

    const inputs = tools.filter((message) => message.name === "TaskInput");
    if (inputs.length === 0) {
      return toolCallOutput(prepared, options, "TaskInput", {
        task_id: taskId,
        chars:
          prompt === "PTY_INTERACTIVE_QUIT"
            ? "import os; print('PTY_INTERACTIVE_PID=' + str(os.getpid()))\n"
            : "print(6 * 7)\n",
        wait_ms: 250,
      });
    }

    const latestInput = inputs.at(-1);
    const expected = prompt === "PTY_INTERACTIVE_QUIT" ? "PTY_INTERACTIVE_PID=" : "42";
    if (latestInput === undefined || !toolMessageText(latestInput).includes(expected)) {
      if (inputs.length >= 20) {
        throw new Error(`Interactive Python fixture did not show ${expected}.`);
      }
      return toolCallOutput(prepared, options, "TaskInput", {
        task_id: taskId,
        chars: "",
        wait_ms: 250,
      });
    }

    if (prompt === "PTY_INTERACTIVE_QUIT") {
      return textOutput(prepared, "PTY_INTERACTIVE_RUNNING");
    }
    if (
      !inputs.some((message) => toolMessageText(message).includes("status=completed"))
    ) {
      return toolCallOutput(prepared, options, "TaskInput", {
        task_id: taskId,
        chars: "exit()\n",
        wait_ms: 500,
      });
    }
    return textOutput(prepared, "PTY_INTERACTIVE_DONE");
  }

  private ptyResume(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    requireTools(input, ["Write"]);
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_RESUME_CONTINUE") {
      requireMessage(input.messages, "user", "PTY_RESUME_SEED");
      requireMessage(input.messages, "assistant", "PTY_RESUME_SEED_DONE");
      requireToolMessage(input.messages, "Write", "Write succeeded");
      return textOutput(prepared, "PTY_RESUME_CONTINUED");
    }
    if (prompt !== "PTY_RESUME_SEED") {
      throw new Error(`Unexpected pty-resume prompt: ${JSON.stringify(prompt)}.`);
    }
    const write = toolMessagesAfterLastUser(input.messages).find(
      (message) => message.name === "Write",
    );
    if (write === undefined) {
      return toolCallOutput(prepared, options, "Write", {
        file_path: "pty-resume.txt",
        content: "PTY_RESUME_SIDE_EFFECT\n",
      });
    }
    if (!toolMessageText(write).includes("Write succeeded")) {
      throw new Error("PTY resume seed Write did not succeed.");
    }
    return textOutput(prepared, "PTY_RESUME_SEED_DONE");
  }

  private ptyInterruptedTool(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): Promise<ModelRequestOutput> | ModelRequestOutput {
    requireTools(input, ["Write"]);
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_INTERRUPT_RECOVER") {
      requireMessage(input.messages, "user", "PTY_INTERRUPT_START");
      requireToolMessage(input.messages, "Write", "Write succeeded");
      return textOutput(prepared, "PTY_INTERRUPT_RECOVERED");
    }
    if (prompt !== "PTY_INTERRUPT_START") {
      throw new Error(
        `Unexpected pty-interrupted-tool prompt: ${JSON.stringify(prompt)}.`,
      );
    }
    const write = toolMessagesAfterLastUser(input.messages).find(
      (message) => message.name === "Write",
    );
    if (write === undefined) {
      return toolCallOutput(prepared, options, "Write", {
        file_path: "pty-interrupted.txt",
        content: "PTY_INTERRUPT_SIDE_EFFECT\n",
      });
    }
    if (!toolMessageText(write).includes("Write succeeded")) {
      throw new Error("PTY interrupted Write did not succeed.");
    }
    return waitForCancellation(options.signal);
  }

  private ptyFailOnce(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
  ): ModelRequestOutput {
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_FAIL_FIRST") {
      throw new Error("PTY_FAKE_PROVIDER_FAILURE");
    }
    if (prompt === "PTY_FAIL_RECOVER") {
      requireMessage(input.messages, "user", "PTY_FAIL_FIRST");
      return textOutput(prepared, "PTY_FAIL_RECOVERED");
    }
    throw new Error(`Unexpected pty-fail-once prompt: ${JSON.stringify(prompt)}.`);
  }

  private ptyPromptInput(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
  ): ModelRequestOutput {
    const prompt = lastUserMessage(input.messages);
    if (prompt === "first\n>second\n中文<") {
      return textOutput(prepared, "PTY_PROMPT_FIRST_DONE");
    }
    if (prompt === "草稿-恢复") {
      requireExactMessage(input.messages, "user", "first\n>second\n中文<");
      requireExactMessage(input.messages, "assistant", "PTY_PROMPT_FIRST_DONE");
      return textOutput(prepared, "PTY_PROMPT_DRAFT_DONE");
    }
    if (prompt === "草稿-恢复-重提") {
      requireExactMessage(input.messages, "user", "草稿-恢复");
      requireExactMessage(input.messages, "assistant", "PTY_PROMPT_DRAFT_DONE");
      return textOutput(prepared, "PTY_PROMPT_HISTORY_DONE");
    }
    throw new Error(`Unexpected pty-prompt-input prompt: ${JSON.stringify(prompt)}.`);
  }

  private ptyFileCommand(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
  ): ModelRequestOutput {
    const prompt = lastUserMessage(input.messages);
    if (prompt === "open src/index.ts now") {
      return textOutput(prepared, "PTY_FILE_SELECTION_DONE");
    }
    if (prompt === "Review shallow and deep files.\nReturn exact marker.") {
      requireExactMessage(input.messages, "user", "open src/index.ts now");
      requireExactMessage(input.messages, "assistant", "PTY_FILE_SELECTION_DONE");
      return textOutput(prepared, "PTY_PROJECT_COMMAND_DONE");
    }
    throw new Error(`Unexpected pty-file-command prompt: ${JSON.stringify(prompt)}.`);
  }

  private ptyClear(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
  ): ModelRequestOutput {
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_CLEAR_SEED") {
      return textOutput(prepared, "PTY_CLEAR_SEED_DONE");
    }
    if (prompt === "PTY_CLEAR_CONTINUE") {
      requireExactMessage(input.messages, "user", "PTY_CLEAR_SEED");
      requireExactMessage(input.messages, "assistant", "PTY_CLEAR_SEED_DONE");
      return textOutput(prepared, "PTY_CLEAR_CONTINUED");
    }
    throw new Error(`Unexpected pty-clear prompt: ${JSON.stringify(prompt)}.`);
  }

  private ptyFork(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    requireTools(input, ["Write"]);
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_FORK_SEED") {
      const write = toolMessagesAfterLastUser(input.messages).find(
        (message) => message.name === "Write",
      );
      if (write === undefined) {
        return toolCallOutput(prepared, options, "Write", {
          file_path: "pty-fork-shared.txt",
          content: "PTY_FORK_SHARED_HISTORY\n",
        });
      }
      if (!toolMessageText(write).includes("Write succeeded")) {
        throw new Error("PTY fork seed Write did not succeed.");
      }
      return textOutput(prepared, "PTY_FORK_SEED_DONE");
    }
    if (prompt === "CLONE_ONLY") {
      requireForkSeed(input.messages);
      requireNoMessage(input.messages, "user", "SOURCE_ONLY");
      return textOutput(prepared, "PTY_CLONE_ONLY_DONE");
    }
    if (prompt === "SOURCE_ONLY") {
      requireForkSeed(input.messages);
      requireNoMessage(input.messages, "user", "CLONE_ONLY");
      return textOutput(prepared, "PTY_SOURCE_ONLY_DONE");
    }
    throw new Error(`Unexpected pty-fork prompt: ${JSON.stringify(prompt)}.`);
  }

  private ptyModelSwitch(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
  ): ModelRequestOutput {
    const prompt = lastUserMessage(input.messages);
    if (prompt !== "PTY_MODEL_ALPHA_TURN") {
      throw new Error(`Unexpected pty-model-switch prompt: ${JSON.stringify(prompt)}.`);
    }
    if (this.options.model !== "alpha-model") {
      throw new Error(
        `PTY model switch dispatched to ${JSON.stringify(this.options.model)}.`,
      );
    }
    return textOutput(prepared, "PTY_MODEL_ALPHA_DONE");
  }

  private ptyViewer(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
  ): ModelRequestOutput {
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_VIEW_SEED") {
      return textOutput(prepared, "PTY_VIEW_SEED_DONE");
    }
    if (prompt === "PTY_VIEW_CONTINUE") {
      requireExactMessage(input.messages, "user", "PTY_VIEW_SEED");
      requireExactMessage(input.messages, "assistant", "PTY_VIEW_SEED_DONE");
      return textOutput(prepared, "PTY_VIEW_CONTINUED");
    }
    throw new Error(`Unexpected pty-viewer prompt: ${JSON.stringify(prompt)}.`);
  }

  private ptyCopy(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
  ): ModelRequestOutput {
    const prompt = lastUserMessage(input.messages);
    if (prompt !== "PTY_COPY_MARKDOWN") {
      throw new Error(`Unexpected pty-copy prompt: ${JSON.stringify(prompt)}.`);
    }
    return textOutput(prepared, ptyCopyMarkdownResponse());
  }

  private ptyContextHeavy(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    requireTools(input, ["Read", "RecallSearch", "RecallGet"]);
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_CONTEXT_HEAVY") {
      const read = toolMessagesAfterLastUser(input.messages).find(
        (message) => message.name === "Read",
      );
      if (read === undefined) {
        return toolCallOutput(prepared, options, "Read", {
          file_path: "context-heavy.txt",
        });
      }
      if (!toolMessageText(read).includes("PTY_CONTEXT_ORIGINAL_MARKER")) {
        throw new Error("PTY context Read did not return the original marker.");
      }
      return textOutput(prepared, "PTY_CONTEXT_HEAVY_DONE");
    }
    if (/^PTY_CONTEXT_PAD_[1-9]$/u.test(prompt)) {
      return textOutput(prepared, `${prompt}_DONE`);
    }
    if (prompt === "PTY_CONTEXT_RECALL") {
      return recallMarker(
        input,
        prepared,
        options,
        "PTY_CONTEXT_ORIGINAL_MARKER",
        "PTY_CONTEXT_RECALLED",
      );
    }
    throw new Error(`Unexpected pty-context-heavy prompt: ${JSON.stringify(prompt)}.`);
  }

  private ptyImage(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
  ): ModelRequestOutput {
    const prompt = lastUserMessage(input.messages);
    if (prompt !== "[Image #1] describe fixture") {
      throw new Error(`Unexpected pty-image prompt: ${JSON.stringify(prompt)}.`);
    }
    const user = [...input.messages]
      .reverse()
      .find(
        (message): message is Extract<AgentMessage, { role: "user" }> =>
          message.role === "user",
      );
    const attachment = user?.attachments?.[0];
    if (
      user?.attachments?.length !== 1 ||
      attachment === undefined ||
      attachment.label !== "[Image #1]" ||
      attachment.originalName !== "fixture.png"
    ) {
      throw new Error("PTY image request has unexpected canonical attachment data.");
    }
    const payload = prepared.payload as {
      readonly materializedAssets?: readonly {
        readonly assetId: ImageAssetId;
        readonly byteLength: number;
        readonly bytesSha256: string;
      }[];
    };
    const materialized = payload.materializedAssets?.[0];
    if (
      !this.materializedRequests.has(prepared) ||
      prepared.mediaOccurrenceCount !== 1 ||
      payload.materializedAssets?.length !== 1 ||
      materialized?.assetId !== attachment.assetId ||
      materialized.byteLength !== attachment.byteLength ||
      !/^[0-9a-f]{64}$/u.test(materialized.bytesSha256)
    ) {
      throw new Error("PTY image request was not materialized from the asset store.");
    }
    return textOutput(prepared, "PTY_IMAGE_DONE");
  }

  private ptyLocalPanels(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
  ): ModelRequestOutput {
    const prompt = lastUserMessage(input.messages);
    if (prompt !== "PTY_LOCAL_AFTER_PANELS") {
      throw new Error(`Unexpected pty-local-panels prompt: ${JSON.stringify(prompt)}.`);
    }
    requireTools(input, ["Skill", "mcp__fixture__echo"]);
    return textOutput(prepared, "PTY_LOCAL_AFTER_PANELS_DONE");
  }

  private ptySkillActivate(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    requireTools(input, ["Skill"]);
    const prompt = lastUserMessage(input.messages);
    if (prompt === "PTY_SKILL_START") {
      const skill = toolMessagesAfterLastUser(input.messages).find(
        (message) => message.name === "Skill",
      );
      if (skill === undefined) {
        return toolCallOutput(prepared, options, "Skill", {
          name: "pty-review",
        });
      }
      if (!toolMessageText(skill).includes("PTY_SKILL_INSTRUCTIONS")) {
        throw new Error("PTY Skill result did not contain the fixture instructions.");
      }
      return textOutput(prepared, "PTY_SKILL_DONE");
    }
    if (prompt === "PTY_SKILL_AFTER_RESUME") {
      requireExactMessage(input.messages, "user", "PTY_SKILL_START");
      requireExactMessage(input.messages, "assistant", "PTY_SKILL_DONE");
      requireSystemContent(input.messages, "PTY_SKILL_INSTRUCTIONS");
      return textOutput(prepared, "PTY_SKILL_RESUMED");
    }
    throw new Error(`Unexpected pty-skill-activate prompt: ${JSON.stringify(prompt)}.`);
  }

  private ptyMcpCall(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    requireTools(input, ["mcp__fixture__echo"]);
    const prompt = lastUserMessage(input.messages);
    if (prompt !== "PTY_MCP_START") {
      throw new Error(`Unexpected pty-mcp-call prompt: ${JSON.stringify(prompt)}.`);
    }
    const echo = toolMessagesAfterLastUser(input.messages).find(
      (message) => message.name === "mcp__fixture__echo",
    );
    if (echo === undefined) {
      return toolCallOutput(prepared, options, "mcp__fixture__echo", {
        message: "PTY_MCP_PAYLOAD",
      });
    }
    if (!toolMessageText(echo).includes("echo: PTY_MCP_PAYLOAD")) {
      throw new Error("PTY MCP echo returned unexpected content.");
    }
    return textOutput(prepared, "PTY_MCP_DONE\n\necho: PTY_MCP_PAYLOAD");
  }

  private writeNotes(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    const sawToolResult = input.messages.some((message) => message.role === "tool");

    if (!sawToolResult) {
      if (options.identity === undefined) {
        throw new Error("Fake tool call requires an iteration identity context.");
      }
      return outputWithUsage(
        prepared,
        {
          role: "assistant",
          content: "I will create notes.txt.",
          toolCalls: [
            {
              ...options.identity.runtimeSession.createToolCall(
                options.identity.iteration,
                1,
              ),
              providerToolCallId: "fake-write-notes-1",
              name: "Write",
              args: {
                file_path: "notes.txt",
                content: "hello.\n",
              },
            },
          ],
        },
        "tool_calls",
      );
    }

    return outputWithUsage(
      prepared,
      {
        role: "assistant",
        content: "Created notes.txt with one line: hello.",
      },
      "stop",
    );
  }

  private recallSmoke(
    input: ModelRequestInput,
    prepared: PreparedModelRequest,
    options: ModelRequestOptions,
  ): ModelRequestOutput {
    if (options.identity === undefined) {
      throw new Error("Fake Recall call requires an iteration identity context.");
    }
    const lastUserIndex = lastMessageIndex(input.messages, "user");
    const latestRecallResult = input.messages
      .slice(lastUserIndex + 1)
      .reverse()
      .find(
        (message): message is Extract<AgentMessage, { role: "tool" }> =>
          message.role === "tool" &&
          (message.name === "RecallSearch" || message.name === "RecallGet"),
      );
    if (latestRecallResult === undefined) {
      return outputWithUsage(
        prepared,
        {
          role: "assistant",
          toolCalls: [
            {
              ...options.identity.runtimeSession.createToolCall(
                options.identity.iteration,
                1,
              ),
              providerToolCallId: "fake-recall-search-1",
              name: "RecallSearch",
              args: { query: "recall-smoke-marker" },
            },
          ],
        },
        "tool_calls",
      );
    }
    const recallText = toolMessageText(latestRecallResult);
    if (recallText.startsWith("Recall searched")) {
      const source = recallText.match(/^source=(ctx:\/\/message\/[0-9a-f-]+)$/m)?.[1];
      if (source === undefined) {
        throw new Error("Fake RecallSearch did not return a source.");
      }
      return outputWithUsage(
        prepared,
        {
          role: "assistant",
          toolCalls: [
            {
              ...options.identity.runtimeSession.createToolCall(
                options.identity.iteration,
                1,
              ),
              providerToolCallId: "fake-recall-get-1",
              name: "RecallGet",
              args: { source },
            },
          ],
        },
        "tool_calls",
      );
    }
    if (!recallText.includes("recall-smoke-marker")) {
      throw new Error("Fake RecallGet did not recover the expected marker.");
    }
    return outputWithUsage(
      prepared,
      {
        role: "assistant",
        content: "RecallSearch and RecallGet completed.",
      },
      "stop",
    );
  }
}

function outputWithUsage(
  prepared: PreparedModelRequest,
  message: AssistantMessage,
  finishReason: string,
): ModelRequestOutput {
  const promptTokens = estimatePromptSegments(prepared.promptSegments).totalTokens;
  const completionTokens = Math.max(
    1,
    estimatePromptSegments(prepared.assistantReplaySegments(message)).totalTokens,
  );
  return {
    message,
    finishReason,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
  };
}

function textOutput(
  prepared: PreparedModelRequest,
  content: string,
): ModelRequestOutput {
  return outputWithUsage(
    prepared,
    {
      role: "assistant",
      content,
    },
    "stop",
  );
}

function toolCallOutput(
  prepared: PreparedModelRequest,
  options: ModelRequestOptions,
  name: string,
  args: Readonly<Record<string, unknown>>,
): ModelRequestOutput {
  if (options.identity === undefined) {
    throw new Error(`Fake ${name} call requires an iteration identity context.`);
  }
  const identity = options.identity;
  return outputWithUsage(
    prepared,
    {
      role: "assistant",
      toolCalls: [
        {
          ...identity.runtimeSession.createToolCall(identity.iteration, 1),
          providerToolCallId: `fake-${name.toLowerCase()}-${identity.iteration.iterationNumber}`,
          name,
          args,
        },
      ],
    },
    "tool_calls",
  );
}

function waitForCancellation(signal: AbortSignal): Promise<ModelRequestOutput> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(cancellationError(signal));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function lastUserMessage(messages: AgentMessage[]): string {
  const users = messages.filter(
    (message): message is { role: "user"; content: string } => message.role === "user",
  );
  return users.at(-1)?.content ?? "";
}

function toolMessagesAfterLastUser(
  messages: AgentMessage[],
): Array<Extract<AgentMessage, { role: "tool" }>> {
  return messages
    .slice(lastMessageIndex(messages, "user") + 1)
    .filter(
      (message): message is Extract<AgentMessage, { role: "tool" }> =>
        message.role === "tool",
    );
}

function toolMessageText(message: Extract<AgentMessage, { role: "tool" }>): string {
  return toolResultDisplayText(message.content);
}

function requireMessage(
  messages: AgentMessage[],
  role: "user" | "assistant",
  content: string,
): void {
  const found = messages.some(
    (message) =>
      message.role === role &&
      typeof message.content === "string" &&
      message.content.includes(content),
  );
  if (!found) {
    throw new Error(`Fake PTY context is missing ${role} content ${content}.`);
  }
}

function requireExactMessage(
  messages: AgentMessage[],
  role: "user" | "assistant",
  content: string,
): void {
  const found = messages.some(
    (message) => message.role === role && message.content === content,
  );
  if (!found) {
    throw new Error(
      `Fake PTY context is missing exact ${role} content ${JSON.stringify(content)}.`,
    );
  }
}

function requireNoMessage(
  messages: AgentMessage[],
  role: "user" | "assistant",
  content: string,
): void {
  const found = messages.some(
    (message) => message.role === role && message.content === content,
  );
  if (found) {
    throw new Error(
      `Fake PTY context unexpectedly contains ${role} content ${JSON.stringify(content)}.`,
    );
  }
}

function requireSystemContent(messages: AgentMessage[], content: string): void {
  const found = messages.some(
    (message) => message.role === "system" && message.content.includes(content),
  );
  if (!found) {
    throw new Error(`Fake PTY system surface is missing ${content}.`);
  }
}

function requireForkSeed(messages: AgentMessage[]): void {
  requireExactMessage(messages, "user", "PTY_FORK_SEED");
  requireExactMessage(messages, "assistant", "PTY_FORK_SEED_DONE");
  requireToolMessage(messages, "Write", "Write succeeded");
}

function requireToolMessage(
  messages: AgentMessage[],
  name: string,
  content: string,
): void {
  const found = messages.some(
    (message) =>
      message.role === "tool" &&
      message.name === name &&
      toolMessageText(message).includes(content),
  );
  if (!found) {
    throw new Error(`Fake PTY context is missing ${name} tool content ${content}.`);
  }
}

function requireTools(input: ModelRequestInput, names: readonly string[]): void {
  const available = new Set(input.tools.map((tool) => tool.name));
  const missing = names.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(`Fake PTY model is missing tools: ${missing.join(", ")}.`);
  }
}

function requireObservationValue(content: string, name: string): string {
  const value = content.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`Fake PTY tool observation is missing ${name}.`);
  }
  return value;
}

function lastMessageIndex(
  messages: AgentMessage[],
  role: AgentMessage["role"],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === role) {
      return index;
    }
  }
  return -1;
}

function toPromptSegment(
  message: AgentMessage,
  messageOrdinal = 0,
): PreparedPromptSegment {
  if (message.role === "user" && message.attachments !== undefined) {
    const media = message.attachments.map(
      (attachment, blockPosition): PreparedMediaOccurrence => {
        const dimensions = providerImageDimensions(attachment.width, attachment.height);
        return Object.freeze({
          asset: Object.freeze({
            assetId: attachment.assetId,
            mimeType: attachment.mimeType,
            byteLength: attachment.byteLength,
            width: attachment.width,
            height: attachment.height,
          }),
          source: "user_attachment",
          messageOrdinal,
          blockPosition,
          width: dimensions.width,
          height: dimensions.height,
          planningTokens: imagePlanningTokens(dimensions.width, dimensions.height),
        });
      },
    );
    return Object.freeze({
      kind: "user",
      normalizedText: message.content,
      media: Object.freeze(media),
    });
  }
  if (message.role === "tool") {
    const media = message.content.flatMap((block, blockPosition) => {
      if (block.type !== "image") {
        return [];
      }
      const dimensions = providerImageDimensions(block.asset.width, block.asset.height);
      return [
        Object.freeze<PreparedMediaOccurrence>({
          asset: Object.freeze({ ...block.asset }),
          source: "tool_result",
          messageOrdinal,
          blockPosition,
          width: dimensions.width,
          height: dimensions.height,
          planningTokens: imagePlanningTokens(dimensions.width, dimensions.height),
        }),
      ];
    });
    return Object.freeze({
      kind: "tool",
      normalizedText: stableJsonStringify(message),
      ...(media.length === 0 ? {} : { media: Object.freeze(media) }),
    });
  }
  return {
    kind:
      message.role === "system"
        ? "kernel"
        : message.role === "user"
          ? "user"
          : message.role,
    normalizedText: stableJsonStringify(message),
  };
}

function distinctPreparedAssets(
  segments: readonly PreparedPromptSegment[],
): Map<ImageAssetId, ImageAssetRef> {
  const assets = new Map<ImageAssetId, ImageAssetRef>();
  for (const segment of segments) {
    for (const media of segment.media ?? []) {
      const asset = media.asset;
      const existing = assets.get(asset.assetId);
      if (
        existing !== undefined &&
        stableJsonStringify(existing) !== stableJsonStringify(asset)
      ) {
        throw new Error(`Conflicting fake image descriptors for ${asset.assetId}.`);
      }
      assets.set(asset.assetId, asset);
    }
  }
  return assets;
}

function materializedFakePromptSegments(
  segments: readonly PreparedPromptSegment[],
  images: readonly {
    assetId: ImageAssetId;
    width: number;
    height: number;
    planningTokens: number;
  }[],
): readonly PreparedPromptSegment[] {
  const byId = new Map(images.map((image) => [image.assetId, image] as const));
  return Object.freeze(
    segments.map((segment) =>
      segment.media === undefined
        ? segment
        : Object.freeze({
            ...segment,
            media: Object.freeze(
              segment.media.map((media) => {
                const image = byId.get(media.asset.assetId);
                if (image === undefined) {
                  throw new Error(
                    `Fake image ${media.asset.assetId} was not materialized.`,
                  );
                }
                return Object.freeze({
                  ...media,
                  width: image.width,
                  height: image.height,
                  planningTokens: image.planningTokens,
                });
              }),
            ),
          }),
    ),
  );
}

function recallMarker(
  input: ModelRequestInput,
  prepared: PreparedModelRequest,
  options: ModelRequestOptions,
  marker: string,
  finalText: string,
): ModelRequestOutput {
  const latestRecallResult = toolMessagesAfterLastUser(input.messages)
    .filter(
      (message) => message.name === "RecallSearch" || message.name === "RecallGet",
    )
    .at(-1);
  if (latestRecallResult === undefined) {
    return toolCallOutput(prepared, options, "RecallSearch", {
      query: marker,
    });
  }
  const recallText = toolMessageText(latestRecallResult);
  if (recallText.startsWith("Recall searched")) {
    const source = recallText.match(/^source=(ctx:\/\/message\/[0-9a-f-]+)$/m)?.[1];
    if (source === undefined) {
      throw new Error("Fake PTY RecallSearch did not return a source.");
    }
    return toolCallOutput(prepared, options, "RecallGet", {
      source,
    });
  }
  if (!recallText.includes(marker)) {
    throw new Error(`Fake PTY RecallGet did not recover ${marker}.`);
  }
  return textOutput(prepared, finalText);
}

export function ptyCopyMarkdownResponse(): string {
  return [
    "# PTY canonical Markdown",
    "",
    "```ts",
    'export const marker = "PTY_COPY_CODE";',
    "```",
    "",
    Array.from({ length: 240 }, (_, index) => `long-${index}`).join(" "),
    "",
    "PTY_COPY_END",
  ].join("\n");
}
