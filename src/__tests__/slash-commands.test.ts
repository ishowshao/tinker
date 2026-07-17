import { describe, expect, test } from "bun:test";
import {
  findSlashCommand,
  matchSlashCommands,
  parseSlashCommand,
  SLASH_COMMANDS,
  type SlashCommand,
} from "../tui/slash-commands";
import { runtimeIdFactory } from "../ids/runtime-id";

const commands: readonly SlashCommand[] = [
  { name: "quit", description: "Exit the TUI" },
  { name: "quiet", description: "Toggle quiet mode" },
  { name: "help", description: "Show help" },
];

describe("matchSlashCommands", () => {
  test("lists all commands for a bare slash", () => {
    expect(matchSlashCommands("/", commands)).toEqual([...commands]);
  });

  test("matches commands by prefix", () => {
    expect(matchSlashCommands("/qui", commands).map((c) => c.name)).toEqual([
      "quit",
      "quiet",
    ]);
  });

  test("returns nothing without a leading slash", () => {
    expect(matchSlashCommands("quit", commands)).toEqual([]);
    expect(matchSlashCommands("", commands)).toEqual([]);
  });

  test("returns nothing once the input contains whitespace", () => {
    expect(matchSlashCommands("/quit ", commands)).toEqual([]);
    expect(matchSlashCommands("/quit now", commands)).toEqual([]);
  });

  test("returns nothing for an unknown prefix", () => {
    expect(matchSlashCommands("/x", commands)).toEqual([]);
  });

  test("defaults to the registered commands", () => {
    expect(matchSlashCommands("/")).toEqual([...SLASH_COMMANDS]);
  });
});

describe("findSlashCommand", () => {
  test("finds a command by exact name", () => {
    expect(findSlashCommand("/quit", commands)?.name).toBe("quit");
  });

  test("ignores trailing arguments", () => {
    expect(findSlashCommand("/quit now", commands)?.name).toBe("quit");
  });

  test("does not match a prefix", () => {
    expect(findSlashCommand("/qui", commands)).toBeUndefined();
  });

  test("returns undefined without a leading slash or for a bare slash", () => {
    expect(findSlashCommand("quit", commands)).toBeUndefined();
    expect(findSlashCommand("/", commands)).toBeUndefined();
  });
});

describe("parseSlashCommand", () => {
  test("parses only the zero-argument /compact command", () => {
    expect(parseSlashCommand("/compact")).toEqual({ type: "compact" });
    expect(() => parseSlashCommand("/compact now")).toThrow("Usage: /compact");
    expect(() => parseSlashCommand("/compact --force")).toThrow("Usage: /compact");
  });

  test("parses /view with relative, absolute, and space-containing paths", () => {
    expect(parseSlashCommand("/view src/tui/app.tsx")).toEqual({
      type: "view",
      filePath: "src/tui/app.tsx",
    });
    expect(parseSlashCommand("/view /tmp/outside.ts")).toEqual({
      type: "view",
      filePath: "/tmp/outside.ts",
    });
    expect(parseSlashCommand("/view docs/design notes.md")).toEqual({
      type: "view",
      filePath: "docs/design notes.md",
    });
  });

  test("rejects /view without a path", () => {
    expect(() => parseSlashCommand("/view")).toThrow("Usage: /view <path>");
    expect(() => parseSlashCommand("/view   ")).toThrow("Usage: /view <path>");
  });

  test("parses resume list, resume target, and confirmed deletion", () => {
    const sessionId = runtimeIdFactory.createSessionId();
    expect(parseSlashCommand("/resume")).toEqual({ type: "resume_list" });
    expect(parseSlashCommand(`/resume ${sessionId}`)).toEqual({
      type: "resume",
      sessionId,
    });
    expect(parseSlashCommand(`/session delete ${sessionId} --confirm`)).toEqual({
      type: "session_delete",
      sessionId,
    });
  });

  test("parses /model with no arguments as model picker", () => {
    expect(parseSlashCommand("/model")).toEqual({ type: "model" });
  });

  test("parses /model with a profile name as model switch", () => {
    expect(parseSlashCommand("/model deepseek")).toEqual({
      type: "model_switch",
      profileName: "deepseek",
    });
  });

  test("rejects /model with too many arguments", () => {
    expect(() => parseSlashCommand("/model a b")).toThrow("Usage: /model");
  });

  test("rejects invalid IDs, extra arguments, and missing confirmation", () => {
    expect(() => parseSlashCommand("/resume not-an-id")).toThrow("Invalid session ID");
    expect(() => parseSlashCommand("/resume a b")).toThrow("Usage: /resume");
    expect(() => parseSlashCommand("/session delete x")).toThrow(
      "Usage: /session delete",
    );
  });
});
