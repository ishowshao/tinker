import { loadRemoteConfig } from "../remote/config";
import { startRemoteHttpServer } from "../remote/http-server";
import { RemoteService } from "../remote/service";
import { RemoteServiceStore } from "../remote/service-store";
import { defaultHomeRoot } from "../session/workspace-storage";
import { createHostedRuntimeFactory } from "./serve-runtime";
import { writeCliOutput, type CliOutputWriter } from "./output";

export async function runServe(input: {
  configPath: string;
  env: NodeJS.ProcessEnv;
  stdout: CliOutputWriter;
}): Promise<number> {
  const config = await loadRemoteConfig(input.configPath);
  const homeRoot = defaultHomeRoot(input.env);
  const store = await RemoteServiceStore.open(config.stateDirectory);
  const service = new RemoteService(
    store,
    config.workspaces,
    createHostedRuntimeFactory(config.workspaces, input.env, homeRoot),
    homeRoot,
  );
  let transport: ReturnType<typeof startRemoteHttpServer> | undefined;
  try {
    await service.initialize();
    transport = startRemoteHttpServer(service, config);
    await writeCliOutput(
      input.stdout,
      `Tinker service listening on https://${config.hostname}:${transport.port}; ${config.workspaces.length} workspace(s).\nClient disconnects detach only. Stop the process to shut down hosted sessions.\n`,
    );
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  } finally {
    await transport?.stopTransport();
    await service.close();
  }
}
