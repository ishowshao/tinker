import { RemoteClient, type RemoteClientConfig } from "../remote/client";
import {
  loadLocalServiceTarget,
  registerLocalWorkspace,
} from "../remote/local-service-discovery";
import { ensureLocalService } from "./local-service-start";

export async function resolveConnectedWorkspace(input: {
  config: RemoteClientConfig;
  cwd: string;
  env: NodeJS.ProcessEnv;
  workspaceId?: string;
  serviceConfigPath?: string;
}): Promise<string> {
  const probe = new RemoteClient(input.config, false);
  try {
    if (input.serviceConfigPath) {
      const target = await loadLocalServiceTarget(input.serviceConfigPath, input.env);
      const local = await ensureLocalService(target, input.env);
      const remote = await probe.request<{ instanceId: string }>("/v1/service");
      if (remote.instanceId !== local.instanceId)
        throw new Error(
          "Client pairing points to a different service. Use the client configuration for this local service before registering a workspace.",
        );
      if (!input.workspaceId)
        return (await registerLocalWorkspace(target, input.cwd)).id;
    }
    if (input.workspaceId) return input.workspaceId;
    return (await probe.resolveWorkspace(input.cwd)).id;
  } finally {
    await probe.close();
  }
}
