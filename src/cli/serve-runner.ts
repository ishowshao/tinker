import { loadPackageMetadata } from "./package-metadata";
import { prepareDefaultServiceConfig } from "./default-service-config";
import { stopLocalService } from "./service-control";
import {
  disableSupervisor,
  installSupervisor,
  startSupervisor,
  uninstallSupervisor,
  supervisedEnvironment,
  supervisorPaths,
} from "./service-supervisor";
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
  install?: boolean;
  uninstall?: boolean;
  stop?: boolean;
  restart?: boolean;
  force?: boolean;
  status?: boolean;
  env: NodeJS.ProcessEnv;
  stdout: CliOutputWriter;
}): Promise<number> {
  const env = await supervisedEnvironment(input.env);
  // MCP and tool subprocesses inherit the service process environment.
  if (input.env.TINKER_SERVICE_ENV_FILE) Object.assign(process.env, env);
  if (input.install && !input.configPath) await prepareDefaultServiceConfig(env);
  const target = await loadLocalServiceTarget(
    input.configPath ?? defaultServiceConfigPath(env),
    env,
  );
  if (input.install && (await Bun.file(supervisorPaths(target).marker).exists())) {
    const instance = await ensureLocalService(target, env);
    await writeCliOutput(
      input.stdout,
      `${JSON.stringify({ status: "online", ...instance })}\n`,
    );
    return 0;
  }
  if (input.install || input.uninstall || input.stop || input.restart) {
    await disableSupervisor(target);
    try {
      await stopLocalService(target, input.force);
    } catch (error) {
      await startSupervisor(target).catch(() => undefined);
      throw error;
    }
    if (input.uninstall) await uninstallSupervisor(target);
    if (input.install) await installSupervisor(target, env);
    const instance =
      input.install || input.restart
        ? await ensureLocalService(target, env)
        : undefined;
    await writeCliOutput(
      input.stdout,
      `${JSON.stringify(instance ? { status: "online", ...instance } : { status: "stopped", stateDirectory: target.config.stateDirectory })}\n`,
    );
    return 0;
  }
  if (input.background || input.status) {
    const instance = input.status
      ? await discoverLocalService(target, true)
      : await ensureLocalService(target, env);
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
      createHostedRuntimeFactory(() => service.workspaces, env, homeRoot),
      homeRoot,
      config.resident,
    );
  } catch (error) {
    await store.close();
    throw error;
  }
  let transport: ReturnType<typeof startRemoteHttpServer> | undefined;
  let unpublish: (() => Promise<void>) | undefined;
  let stopRequested = false;
  let signalStop: (() => void) | undefined;
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  const setDeadline = () => {
    hardStop ??= setTimeout(
      () => {
        console.error(
          "Service shutdown timed out; recovery will mark unfinished work interrupted on restart.",
        );
        process.exit(1);
      },
      (config.resident?.shutdownGraceMs ?? 30000) + 10000,
    );
    hardStop.unref();
  };
  const stop = () => {
    setDeadline();
    stopRequested = true;
    signalStop?.();
  };
  const onSignal = () => {
    setDeadline();
    void service
      .drain(true)
      .catch(() => undefined)
      .finally(stop);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
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
        {
          appVersion: (await loadPackageMetadata()).version,
          status: () => service.residentStatus(),
          shutdown: async (force, idleOnly) => {
            await service.drain(force, idleOnly);
            return stop;
          },
        },
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
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      await unpublish?.();
    } finally {
      try {
        await transport?.stopTransport();
      } finally {
        await service.close();
        if (hardStop) clearTimeout(hardStop);
      }
    }
  }
}
