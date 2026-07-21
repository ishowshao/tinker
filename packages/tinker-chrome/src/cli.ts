#!/usr/bin/env bun
import process from "node:process";
import { diagnoseChromeBridge } from "./diagnose";
import { extensionBuildRoot } from "./extension-path";
import { installNativeHost } from "./install-host";
import { runTinkerChromeMcpServer } from "./mcp-server";
import { runNativeHost } from "./native-host";

const [command = "mcp", ...args] = process.argv.slice(2);

try {
  if (command === "mcp") {
    requireNoArgs(args, command);
    await runTinkerChromeMcpServer();
  } else if (command === "native-host") {
    await runNativeHost(args);
  } else if (command === "install-host") {
    requireNoArgs(args, command);
    const installation = await installNativeHost();
    process.stdout.write(`${JSON.stringify(installation, null, 2)}\n`);
  } else if (command === "diagnose") {
    requireNoArgs(args, command);
    const diagnosis = await diagnoseChromeBridge();
    process.stdout.write(`${JSON.stringify(diagnosis, null, 2)}\n`);
    if (!diagnosis.ok) {
      process.exitCode = 1;
    }
  } else if (command === "extension-path") {
    requireNoArgs(args, command);
    process.stdout.write(`${extensionBuildRoot()}\n`);
  } else {
    throw new Error(
      "Usage: cli.ts [mcp|native-host|install-host|diagnose|extension-path]",
    );
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
}

function requireNoArgs(args: string[], command: string): void {
  if (args.length !== 0) {
    throw new Error(`${command} does not accept arguments.`);
  }
}
