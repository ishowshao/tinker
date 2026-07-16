#!/usr/bin/env bun
import { runOneShot } from "./run-runner";
import { runTui } from "./tui-runner";

const [, , command, ...args] = process.argv;

if (command === "run") {
  const prompt = args.join(" ").trim();

  if (prompt === "") {
    process.stderr.write('Usage: tinker run "prompt"\n');
    process.exit(2);
  }

  const exitCode = await runOneShot(prompt);
  process.exit(exitCode);
}

if (command === "--profile" || command === "-p") {
  const profileName = args[0];
  if (profileName === undefined) {
    process.stderr.write("Usage: tinker --profile <profile-name>\n");
    process.exit(2);
  }
  await runTui({ profileName });
  process.exit(0);
}

await runTui();
