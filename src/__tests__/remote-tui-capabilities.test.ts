import { expect, test } from "bun:test";
import path from "node:path";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { createRemoteTuiClient } from "../client/remote-workspace-client";
import { RemoteClient } from "../remote/client";
import { CapabilityModel, catalog } from "./helpers/remote-capability-model";
import type { ModelClient } from "../model/model-client";
import { createUuidV7 } from "../ids/uuid-v7";
import { parseImageAttachmentId } from "../image/image-types";

import {
  remoteTuiFixture,
  RemoteExecutionModel,
} from "./helpers/remote-tui-test-support";
import { until } from "./helpers/remote-test-support";

test("service model switching creates a new session, retains profile on clear and shares reasoning", async () => {
  const f = await remoteTuiFixture(new CapabilityModel(), catalog);
  const a = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  const b = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  try {
    expect(a.client.getBinding().modelProfiles!()?.profiles.size).toBe(2);
    await a.client.getBinding().setReasoningEffort!("high");
    expect(a.client.getBinding().reasoningEffort!()?.effort).toBe("high");
    await until(() => b.client.getBinding().reasoningEffort!()?.effort === "high");
    await b.client.getBinding().resetReasoningEffort!();
    await until(
      () => a.client.getBinding().reasoningEffort!()?.source === "profile_default",
    );
    expect(a.client.getBinding().setReasoningEffort!("invalid")).rejects.toThrow(
      "Unsupported",
    );
    await a.client.switchModel(catalog.profiles[1]);
    expect(a.client.getBinding().sessionId).not.toBe(
      f.sessionId as import("../ids/runtime-id").SessionId,
    );
    expect(a.client.getBinding().profileName).toBe("large");
    expect(a.client.getBinding().modelName).toBe("large-model");
    expect(b.client.getBinding().sessionId).toBe(
      f.sessionId as import("../ids/runtime-id").SessionId,
    );
    await a.client.persistDefaultProfile("large");
    expect((await f.factory.profiles!("test"))?.defaultProfile).toBe("large");
    await a.client.clear();
    expect(a.client.getBinding().profileName).toBe("large");
    await a.client
      .getBinding()
      .executeTurn({ role: "user", content: "hello" }, new AbortController().signal);
    expect(a.client.switchModel(catalog.profiles[0])).rejects.toThrow(
      "after the session has turns",
    );
  } finally {
    await a.close({ type: "client_exit" });
    await b.close({ type: "client_exit" });
    await f.cleanup();
  }
});

test("service undo, clone and context maintenance use the hosted canonical session", async () => {
  const f = await remoteTuiFixture(new CapabilityModel(true));
  const a = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  const wire = new RemoteClient(f.clientConfig, false);
  try {
    await Bun.write(path.join(f.workspace, "target.txt"), "before");
    await a.client
      .getBinding()
      .executeTurn({ role: "user", content: "edit" }, new AbortController().signal);
    expect(await Bun.file(path.join(f.workspace, "target.txt")).text()).toBe("after");
    const input = { kind: "undo", sessionId: f.sessionId, requestId: randomUUID() };
    const receipt = await wire.request<import("../remote/protocol").OperationReceipt>(
      "/v1/operations",
      input,
    );
    const done = await f.terminal(receipt);
    expect(done.sessionResult).toMatchObject({
      kind: "undo",
      value: { status: "restored" },
    });
    expect(
      await wire.request<import("../remote/protocol").OperationReceipt>(
        "/v1/operations",
        input,
      ),
    ).toEqual(done);
    expect(await Bun.file(path.join(f.workspace, "target.txt")).text()).toBe("before");
    expect((await a.client.compact()).status).toBe("unchanged");
    expect((await a.client.retire()).status).toBe("unchanged");
    const clone = await a.client.fork();
    expect(clone).not.toBe(f.sessionId as import("../ids/runtime-id").SessionId);
    expect(
      JSON.stringify(a.client.getBinding().projectionStore.getSnapshot()),
    ).toContain("CAPABILITY_DONE");
    expect(
      f.service.session(f.sessionId).view().history.messages.length,
    ).toBeGreaterThan(0);
    expect(await a.client.getBinding().readLastResponse()).toBe("CAPABILITY_DONE");
    expect(await a.client.listFiles("", new AbortController().signal)).toContain(
      "target.txt",
    );
    expect((await a.client.readFile("", "target.txt")).lines).toEqual(["before"]);
    expect(a.client.readFile("", "../client.json")).rejects.toThrow("outside");
  } finally {
    await wire.close();
    await a.close({ type: "client_exit" });
    await f.cleanup();
  }
});

test("client image upload and server workspace image selection survive execution and cloning", async () => {
  const model = new CapabilityModel();
  const imageModel: ModelClient = {
    inputModalities: ["text", "image"],
    toolResultModalities: ["text"],
    messageProtocol: model.messageProtocol,
    prepare: model.prepare.bind(model),
    request: model.request.bind(model),
  };
  const f = await remoteTuiFixture(imageModel);
  const a = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  try {
    const bytes = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const localPath = path.join(f.root, "terminal-image.png");
    await Bun.write(localPath, bytes);
    await Bun.write(path.join(f.workspace, "workspace-image.png"), bytes);
    const binding = a.client.getBinding();
    expect(binding.supportsImageInput!()).toBe(true);
    const signal = new AbortController().signal;
    const imported = await binding.importImage!(localPath, signal, 1);
    const asset = imported.asset;
    expect(await binding.importImage!("workspace-image.png", signal, 1)).toMatchObject({
      asset: { assetId: asset.assetId },
    });
    expect(binding.importImage!("../terminal-image.png", signal, 1)).rejects.toThrow();
    expect(
      binding.verifyImageAssets!([{ ...asset, width: 3 }], signal),
    ).rejects.toThrow();
    const attachment = {
      ...asset,
      originalName: imported.originalName,
      attachmentId: parseImageAttachmentId(createUuidV7()),
      label: "[Image #1]",
      range: { start: 0, end: 10 },
    };
    await binding.executeTurn(
      { role: "user", content: "[Image #1] describe", attachments: [attachment] },
      signal,
    );
    expect(model.inputs[0]).toContain(asset.assetId);
    await a.client.fork();
    await a.client.getBinding().verifyImageAssets!([asset], signal);
    expect(
      JSON.stringify(a.client.getBinding().projectionStore.getSnapshot()),
    ).toContain("terminal-image.png");
    await a.client
      .getBinding()
      .executeTurn({ role: "user", content: "continue" }, signal);
    expect(model.inputs.at(-1)).toContain(asset.assetId);
  } finally {
    await a.close({ type: "client_exit" });
    await f.cleanup();
  }
});

test("running turns exclude all session maintenance without stopping their owner", async () => {
  const model = new RemoteExecutionModel(false);
  const f = await remoteTuiFixture(model);
  const a = await createRemoteTuiClient(f.clientConfig, "test", f.sessionId);
  try {
    const turn = await a.client.getBinding().admitTurn!(
      { role: "user", content: "wait" },
      new AbortController().signal,
    );
    await until(() => model.calls.length === 1);
    for (const operation of [
      () => a.client.compact(),
      () => a.client.retire(),
      () => a.client.undo(),
      () => a.client.fork(),
    ]) {
      expect(operation()).rejects.toThrow("active");
    }
    expect(model.aborted).toBe(false);
    model.calls[0].release();
    await turn.completion;
  } finally {
    await a.close({ type: "client_exit" });
    await f.cleanup();
  }
});

test("hosted model catalog exposes only display fields and persists the default on the service", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { createHostedRuntimeFactory } = await import("../cli/serve-runtime");
  const root = await mkdtemp(path.join(tmpdir(), "tinker-catalog-"));
  const configPath = path.join(root, "models.json");
  try {
    const profiles = Object.fromEntries(
      catalog.profiles.map((p) => [
        p.name,
        {
          model: p.model,
          contextWindowTokens: p.contextWindowTokens,
          maxSupportedOutputTokens: p.maxSupportedOutputTokens,
          apiKey: "private-token",
          apiBase: "https://private-provider.test/v1",
        },
      ]),
    );
    await Bun.write(configPath, JSON.stringify({ default: "small", profiles }));
    const factory = createHostedRuntimeFactory(
      [{ id: "test", name: "Test", path: root }],
      { TINKER_MODELS: configPath },
    );
    expect(await factory.profiles!("test")).toEqual(catalog);
    await factory.persistDefaultProfile!("test", "large");
    expect((await factory.profiles!("test"))?.defaultProfile).toBe("large");
    expect(await Bun.file(configPath).text()).toContain("private-token");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote failures preserve the existing context-maintenance and image UI branches", async () => {
  const { encodeFailure, decodeFailure } = await import("../remote/failures");
  const { ContextBudgetExceededError } = await import(
    "../model/model-request-preflight"
  );
  const { ContextManagerError } = await import("../context/context-manager");
  const { ModelRequestMediaAggregateError } = await import("../model/model-client");
  const { ImageNotRecognizedError } = await import("../image/image-probe");
  const errors = [
    new ContextBudgetExceededError({
      projectedInputTokens: 101,
      inputBudgetTokens: 100,
      contextWindowTokens: 120,
      requestMaxOutputTokens: 20,
      triggerTokens: 80,
      source: "estimated_full",
    }),
    new ContextManagerError("plan", "NO_PLAN", false, false, "failed"),
    new ModelRequestMediaAggregateError("too many images"),
    new ImageNotRecognizedError("not an image"),
  ];
  for (const error of errors) {
    const decoded = decodeFailure(
      JSON.parse(JSON.stringify(encodeFailure(error))) as ReturnType<
        typeof encodeFailure
      >,
    );
    expect(decoded).toBeInstanceOf(error.constructor);
    expect(decoded.message).toBe(error.message);
    expect(Object.keys(decoded).sort()).toEqual(Object.keys(error).sort());
  }
});
