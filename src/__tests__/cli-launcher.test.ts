import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runExecutable } from "../cli/index";
import { loadPackageMetadata, PackageMetadataError } from "../cli/package-metadata";

class MemoryWriter {
  output = "";

  write(chunk: string): boolean {
    this.output += chunk;
    return true;
  }
}

describe("CLI executable boundaries", () => {
  test("loads version from the installed package metadata source", async () => {
    expect(await loadPackageMetadata()).toMatchObject({
      name: "tinker-agent",
      version: "2.2.0",
    });
  });

  test("maps missing and malformed package metadata to a typed bootstrap error", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "tinker-package-meta-"));
    try {
      const malformed = path.join(directory, "package.json");
      await writeFile(malformed, "{not-json");
      for (const target of [malformed, path.join(directory, "missing.json")]) {
        const error = await loadPackageMetadata(pathToFileURL(target)).catch(
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(PackageMetadataError);
        expect((error as Error).message).toBe(
          "Tinker package metadata is unavailable.",
        );
        expect((error as Error).message).not.toContain(directory);
      }
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test("keeps index imports inert and maps lazy main failures", async () => {
    const stderr = new MemoryWriter();
    const code = await runExecutable(
      {
        args: [],
        stdin: emptyInput(),
        stdout: process.stdout,
        stderr: stderr as unknown as NodeJS.WriteStream,
        cwd: process.cwd(),
        env: {},
      },
      async () => {
        throw new Error("private module path");
      },
    );
    expect(code).toBe(1);
    expect(stderr.output).toBe("Tinker failed to start. Reinstall tinker-agent.\n");

    stderr.output = "";
    const unexpected = await runExecutable(
      {
        args: [],
        stdin: emptyInput(),
        stdout: process.stdout,
        stderr: stderr as unknown as NodeJS.WriteStream,
        cwd: process.cwd(),
        env: {},
      },
      async () => ({
        BOOTSTRAP_FAILURE_MESSAGE: "Tinker failed to start. Reinstall tinker-agent.\n",
        main: async () => {
          throw new Error("private stack");
        },
      }),
    );
    expect(unexpected).toBe(1);
    expect(stderr.output).toBe("Tinker failed unexpectedly.\n");
  });

  test("importing main and index in a fresh process has no output or exit side effect", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'const before = process.exitCode; await import("./src/cli/main.ts"); await import("./src/cli/index.ts"); if (process.exitCode !== before) throw new Error("exitCode changed");',
      ],
      cwd: path.join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("");
  });

  test("Node launcher propagates ordinary status and signals without process.exit", () => {
    const script = String.raw`
      import { EventEmitter } from "node:events";
      import { launchTinker } from "./bin/tinker.js";
      const output = { value: "", write(chunk) { this.value += chunk; } };
      let spawnArgs;
      let forwarded;
      const completedChild = (code, signal = null) => {
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("exit", code, signal));
        return child;
      };
      const status = await launchTinker(
        { args: ["--version"], stderr: output },
        {
          resolveBundledBun: () => "/pkg/node_modules/bun/package.json",
          spawn: (...args) => { spawnArgs = args; return completedChild(7); },
          forwardSignal: () => { throw new Error("unexpected signal"); },
        },
      );
      if (status !== 7 || !spawnArgs[0].endsWith("/bun/bin/bun.exe")) throw new Error("status propagation failed");
      const signaled = await launchTinker(
        { args: [], stderr: output },
        {
          resolveBundledBun: () => "/pkg/node_modules/bun/package.json",
          spawn: () => completedChild(null, "SIGTERM"),
          forwardSignal: (signal) => { forwarded = signal; },
        },
      );
      if (signaled !== 1 || forwarded !== "SIGTERM") throw new Error("signal propagation failed");
      const missing = await launchTinker(
        { args: [], stderr: output },
        { resolveBundledBun: () => { throw new Error("secret"); } },
      );
      if (missing !== 1 || output.value !== "Tinker failed to start. Reinstall tinker-agent.\n") throw new Error("bootstrap mapping failed");
      output.value = "";
      const failedChild = await launchTinker(
        { args: [], stderr: output },
        {
          resolveBundledBun: () => "/pkg/node_modules/bun/package.json",
          spawn: () => {
            const child = new EventEmitter();
            queueMicrotask(() => child.emit("error", new Error("private spawn failure")));
            return child;
          },
        },
      );
      if (failedChild !== 1 || output.value !== "Tinker failed to start. Reinstall tinker-agent.\n") throw new Error("spawn mapping failed");
    `;
    const result = Bun.spawnSync({
      cmd: ["node", "--input-type=module", "-e", script],
      cwd: path.join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
  });

  test("real Node launcher exposes help and bare package version", () => {
    const repositoryRoot = path.join(import.meta.dir, "../..");
    const version = Bun.spawnSync({
      cmd: ["node", "bin/tinker.js", "--version"],
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString()).toBe("2.2.0\n");
    expect(version.stderr.toString()).toBe("");

    const help = Bun.spawnSync({
      cmd: ["node", "bin/tinker.js", "help", "run"],
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("Usage: tinker run");
    expect(help.stderr.toString()).toBe("");
  });

  test("real Node launcher forwards piped stdin to bundled Bun", async () => {
    const repositoryRoot = path.join(import.meta.dir, "../..");
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-launcher-stdin-"));
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name.startsWith("TINKER_") || name === "EXA_API_KEY") {
        delete env[name];
      }
    }
    Object.assign(env, {
      HOME: workspace,
      TINKER_MODEL: "launcher-test-model",
      TINKER_BASE_URL: "https://api.example.test/v1",
      TINKER_API_KEY: "placeholder-key",
      TINKER_CONTEXT_WINDOW_TOKENS: String(128 * 1_024),
      TINKER_MAX_SUPPORTED_OUTPUT_TOKENS: String(16 * 1_024),
      TINKER_TEST_FAKE_MODEL: "launcher-stdin",
      TINKER_WORKSPACE: workspace,
    });
    try {
      const child = spawn(
        "node",
        [path.join(repositoryRoot, "bin", "tinker.js"), "run", "--stdin"],
        {
          cwd: workspace,
          env,
          stdio: "pipe",
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.stdin.end("launcher stdin\nsecond line\n");
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(exitCode).toBe(0);
      expect(Buffer.concat(stdout).toString()).toContain(
        "Fake model received: launcher stdin\nsecond line\n",
      );
      expect(Buffer.concat(stderr).toString()).toBe("");
    } finally {
      await rm(workspace, { recursive: true });
    }
  });
});

async function* emptyInput(): AsyncIterable<never> {}
