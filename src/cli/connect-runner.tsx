import { render } from "ink";
import { RemoteClient, loadRemoteClientConfig } from "../remote/client";
import { RemoteApp } from "../tui/remote-app";
import type { CliOutputWriter } from "./output";

export async function runConnect(input: {
  configPath: string;
  env: NodeJS.ProcessEnv;
  stdout: CliOutputWriter;
}): Promise<number> {
  if (!process.stdin.isTTY)
    throw new Error("tinker connect requires an interactive terminal.");
  const client = new RemoteClient(await loadRemoteClientConfig(input.configPath));
  let instance: ReturnType<typeof render> | undefined;
  try {
    await client.initialize();
    instance = render(<RemoteApp client={client} />, { incrementalRendering: true });
    await instance.waitUntilExit();
    return 0;
  } finally {
    instance?.unmount();
    await client.close();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
