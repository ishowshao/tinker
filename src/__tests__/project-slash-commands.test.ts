import { describe, expect, test } from "bun:test";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadProjectSlashCommands,
  parseProjectSlashCommands,
  PROJECT_CONFIG_MAX_BYTES,
  resolveProjectSlashCommand,
} from "../tui/project-slash-commands";

function config(commands: unknown[]): string {
  return JSON.stringify({ version: 1, slashCommands: commands });
}

const validCommand = {
  name: "git-commit-and-push",
  description: "Commit and push changes",
  prompt: "Please commit and push the workspace changes.",
};

describe("project slash command configuration", () => {
  test("returns no commands when .tinker.json is absent", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-commands-"));
    expect(await loadProjectSlashCommands(workspace)).toEqual([]);
  });

  test("parses commands in configuration order", () => {
    const commands = parseProjectSlashCommands(
      config([
        validCommand,
        {
          name: "review-changes",
          description: "Review changes",
          prompt: "Review the changes without editing files.",
        },
      ]),
      "/workspace/.tinker.json",
    );

    expect(commands.map((command) => command.name)).toEqual([
      "git-commit-and-push",
      "review-changes",
    ]);
    expect(commands[0]?.prompt).toBe(validCommand.prompt);
  });

  test("rejects invalid structure, unknown fields, and empty text", () => {
    expect(() => parseProjectSlashCommands("[]", "/workspace/.tinker.json")).toThrow(
      "configuration must be an object",
    );
    expect(() =>
      parseProjectSlashCommands(
        JSON.stringify({ version: 2, slashCommands: [] }),
        "/workspace/.tinker.json",
      ),
    ).toThrow('"version" must be 1');
    expect(() =>
      parseProjectSlashCommands(
        JSON.stringify({ version: 1, slashCommands: [], extra: true }),
        "/workspace/.tinker.json",
      ),
    ).toThrow('unknown field "extra"');
    expect(() =>
      parseProjectSlashCommands(
        config([{ ...validCommand, prompt: " " }]),
        "/workspace/.tinker.json",
      ),
    ).toThrow("prompt must be a non-empty string");
  });

  test("rejects invalid, duplicate, and built-in names", () => {
    expect(() =>
      parseProjectSlashCommands(
        config([{ ...validCommand, name: "Bad_Name" }]),
        "/workspace/.tinker.json",
      ),
    ).toThrow("must match");
    expect(() =>
      parseProjectSlashCommands(
        config([validCommand, validCommand]),
        "/workspace/.tinker.json",
      ),
    ).toThrow("duplicates /git-commit-and-push");
    expect(() =>
      parseProjectSlashCommands(
        config([{ ...validCommand, name: "resume" }]),
        "/workspace/.tinker.json",
      ),
    ).toThrow("conflicts with built-in command /resume");
    expect(() =>
      parseProjectSlashCommands(
        config([{ ...validCommand, name: "clear" }]),
        "/workspace/.tinker.json",
      ),
    ).toThrow("conflicts with built-in command /clear");
  });

  test("accepts a valid file at the 1 MiB limit and rejects a larger file", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-commands-"));
    const configPath = path.join(workspace, ".tinker.json");
    const raw = config([validCommand]);
    await writeFile(configPath, raw.padEnd(PROJECT_CONFIG_MAX_BYTES, " "));
    expect((await loadProjectSlashCommands(workspace))[0]?.name).toBe(
      "git-commit-and-push",
    );

    await writeFile(configPath, raw.padEnd(PROJECT_CONFIG_MAX_BYTES + 1, " "));
    expect(loadProjectSlashCommands(workspace)).rejects.toThrow(
      `the limit is ${PROJECT_CONFIG_MAX_BYTES} bytes`,
    );
  });

  test("rejects a symlink that resolves outside the workspace", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-commands-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "tinker-commands-outside-"));
    const target = path.join(outside, "config.json");
    await writeFile(target, config([validCommand]));
    await symlink(target, path.join(workspace, ".tinker.json"));

    expect(loadProjectSlashCommands(workspace)).rejects.toThrow(
      "resolves outside the workspace",
    );
  });
});

describe("resolveProjectSlashCommand", () => {
  const commands = parseProjectSlashCommands(
    config([validCommand]),
    "/workspace/.tinker.json",
  );

  test("resolves only an exact command invocation", () => {
    expect(resolveProjectSlashCommand("/git-commit-and-push", commands)?.prompt).toBe(
      validCommand.prompt,
    );
    expect(resolveProjectSlashCommand("/unknown", commands)).toBeUndefined();
  });

  test("rejects arguments", () => {
    expect(() =>
      resolveProjectSlashCommand("/git-commit-and-push now", commands),
    ).toThrow("Usage: /git-commit-and-push");
  });
});
