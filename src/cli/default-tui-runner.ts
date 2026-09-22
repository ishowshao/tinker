import { resolveUserPath } from "./public-config-contract";
import type { CliOutputWriter } from "./output";
import { prepareDefaultConnection } from "./default-service-config";
import { runConnect } from "./connect-runner";

export async function runDefaultTui(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: CliOutputWriter;
  profileName?: string;
}): Promise<number> {
  if (!process.stdin.isTTY)
    throw new Error(
      "tinker requires an interactive terminal. Use tinker run for one-shot execution.",
    );
  const configs = await prepareDefaultConnection(input.env);
  return runConnect({
    ...input,
    ...configs,
    cwd: resolveUserPath(input.cwd, input.env.TINKER_WORKSPACE?.trim() || "."),
    tui: true,
  });
}
