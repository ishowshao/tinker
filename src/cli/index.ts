#!/usr/bin/env bun

type MainModule = typeof import("./main");

export async function runExecutable(
  input: {
    readonly args: readonly string[];
    readonly stdin: AsyncIterable<unknown>;
    readonly stdout: NodeJS.WriteStream;
    readonly stderr: NodeJS.WriteStream;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  } = {
    args: process.argv.slice(2),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: process.cwd(),
    env: process.env,
  },
  loadMain: () => Promise<MainModule> = () => import("./main"),
): Promise<number> {
  let mainModule: MainModule;
  try {
    mainModule = await loadMain();
  } catch {
    input.stderr.write("Tinker failed to start. Reinstall tinker-agent.\n");
    return 1;
  }

  try {
    return await mainModule.main(input);
  } catch {
    input.stderr.write("Tinker failed unexpectedly.\n");
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runExecutable();
}
