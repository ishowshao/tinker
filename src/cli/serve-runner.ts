import {
  defaultServiceConfigPath,
  discoverLocalService,
  loadLocalServiceTarget,
  publishLocalService,
} from "../remote/local-service-discovery";
import { ensureLocalService } from "./local-service-start";
import { startRemoteHttpServer } from "../remote/http-server";
import { RemoteService } from "../remote/service";
import { RemoteServiceStore } from "../remote/service-store";
import { createHostedRuntimeFactory } from "./serve-runtime";
import { writeCliOutput, type CliOutputWriter } from "./output";

export async function runServe(input: {
  configPath?: string;
  background?: boolean;
  status?: boolean;
  env: NodeJS.ProcessEnv;
  stdout: CliOutputWriter;
}): Promise<number> {
  const target = await loadLocalServiceTarget(
    input.configPath ?? defaultServiceConfigPath(input.env),
    input.env,
  );
  if (input.background || input.status) {
    const instance = input.status
      ? await discoverLocalService(target)
      : await ensureLocalService(target, input.env);
    await writeCliOutput(
      input.stdout,
      `${JSON.stringify(
        instance
          ? { status: "online", ...instance }
          : {
              status: "offline",
              configPath: target.configPath,
              stateDirectory: target.config.stateDirectory,
            },
      )}\n`,
    );
    return instance ? 0 : 1;
  }
  const { config, homeRoot } = target;
  const store = await RemoteServiceStore.open(config.stateDirectory);
  let service: RemoteService;
  try {
    service = new RemoteService(
      store,
      config.workspaces,
      createHostedRuntimeFactory(() => service.workspaces, input.env, homeRoot),
      homeRoot,
    );
  } catch (error) {
    await store.close();
    throw error;
  }
  let transport: ReturnType<typeof startRemoteHttpServer> | undefined;
  let unpublish: (() => Promise<void>) | undefined;
  let stopRequested = false;
  let signalStop: (() => void) | undefined;
  const stop = () => {
    stopRequested = true;
    signalStop?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await service.initialize();
    transport = startRemoteHttpServer(service, config);
    if (stopRequested) return 0;
    if (process.platform !== "win32")
      unpublish = await publishLocalService(
        target,
        service.epoch,
        transport.port,
        (directory) => service.registerLocalWorkspace(directory),
      );
    await writeCliOutput(
      input.stdout,
      `Tinker service listening on https://${config.hostname === "::1" ? "[::1]" : config.hostname}:${transport.port}; ${service.workspaces.length} workspace(s).\nClient disconnects detach only. Stop the process to shut down hosted sessions.\n`,
    );
    await new Promise<void>((resolve) => {
      signalStop = resolve;
      if (stopRequested) resolve();
    });
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    try {
      await unpublish?.();
    } finally {
      try {
        await transport?.stopTransport();
      } finally {
        await service.close();
      }
    }
  }
}
