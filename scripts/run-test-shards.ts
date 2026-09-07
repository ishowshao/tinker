import { spawn, type ChildProcess } from "node:child_process";

const SHARD_COUNT = 12;

export async function runTestShards(args: string[]): Promise<number> {
  if (
    args.some((arg) =>
      ["--shard", "--parallel", "--isolate", "--watch", "-w"].some(
        (flag) => arg === flag || arg.startsWith(`${flag}=`),
      ),
    )
  ) {
    console.error(
      "Use bun test directly for custom sharding, isolation or watch mode.",
    );
    return 1;
  }

  const workers = new Set<ChildProcess>();
  let interrupted: NodeJS.Signals | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const signalWorkers = (signal: NodeJS.Signals) => {
    for (const worker of workers) {
      try {
        if (process.platform !== "win32" && worker.pid !== undefined) {
          process.kill(-worker.pid, signal);
        } else {
          worker.kill(signal);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error(error);
      }
    }
  };
  const interrupt = (signal: NodeJS.Signals) => {
    interrupted ??= signal;
    signalWorkers(signal);
    escalation ??= setTimeout(() => signalWorkers("SIGKILL"), 2_000);
    escalation.unref();
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  try {
    const results = await Promise.all(
      Array.from({ length: SHARD_COUNT }, (_, index) => {
        const shard = `${index + 1}/${SHARD_COUNT}`;
        return new Promise<number>((resolve) => {
          const started = performance.now();
          const worker = spawn(
            process.execPath,
            ["test", ...args, `--shard=${shard}`],
            {
              stdio: "inherit",
              env: { ...process.env, FORCE_COLOR: "0" },
              detached: process.platform !== "win32",
            },
          );
          workers.add(worker);
          worker.on("error", (error) => {
            console.error(`Test shard ${shard} could not start:`, error);
          });
          worker.on("close", (code, signal) => {
            workers.delete(worker);
            const seconds = ((performance.now() - started) / 1_000).toFixed(2);
            console.error(
              `Test shard ${shard}: ${code === 0 ? "passed" : "failed"} (${seconds}s, ${signal ?? `exit ${code ?? 1}`}).`,
            );
            resolve(code ?? 1);
          });
        });
      }),
    );
    if (interrupted !== undefined) return interrupted === "SIGINT" ? 130 : 143;
    return results.every((code) => code === 0) ? 0 : 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    if (escalation !== undefined) clearTimeout(escalation);
    signalWorkers("SIGKILL");
  }
}

if (import.meta.main) process.exitCode = await runTestShards(process.argv.slice(2));
