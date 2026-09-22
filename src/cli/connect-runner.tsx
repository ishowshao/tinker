import { App } from "../tui/app";
import { prepareShikiHighlighter } from "../tui/shiki-highlighter";
import { clipboardWriterForEnvironment } from "../tui/clipboard";
import { createRemoteTuiClient } from "../client/remote-workspace-client";
import { render } from "ink";
import { RemoteClient, loadRemoteClientConfig } from "../remote/client";
import { RemoteApp } from "../tui/remote-app";
import type { CliOutputWriter } from "./output";

export async function runConnect(input: {
  configPath: string;
  env: NodeJS.ProcessEnv;
  stdout: CliOutputWriter;
  tui?: boolean;
  workspaceId?: string;
  sessionId?: string;
}): Promise<number> {
  if (!process.stdin.isTTY)
    throw new Error("tinker connect requires an interactive terminal.");
  if (input.tui) return runFullTui(input);
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

async function runFullTui(input: {
  configPath: string;
  env: NodeJS.ProcessEnv;
  workspaceId?: string;
  sessionId?: string;
}): Promise<number> {
  if (!input.workspaceId) throw new Error("Full service TUI requires a workspace ID.");
  const connection = await createRemoteTuiClient(
    await loadRemoteClientConfig(input.configPath),
    input.workspaceId,
    input.sessionId,
  );
  let instance: ReturnType<typeof render> | undefined;
  try {
    await prepareShikiHighlighter();
    instance = render(
      <App
        sessionController={connection.client}
        initialNotice="Service TUI preview: /clear creates; /resume connects. Task execution and live tool details are not enabled in this batch."
        readViewFile={async () => {
          throw new Error("Remote file viewing is not available in this batch.");
        }}
        writeClipboard={clipboardWriterForEnvironment(input.env)}
        memoryDisabledNotice="Remote memory browsing is not available in this batch."
      />,
      { incrementalRendering: true },
    );
    await instance.waitUntilExit();
    return 0;
  } finally {
    instance?.unmount();
    await connection.close({ type: "client_exit" });
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
