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
  test("parses the session-local yolo controls", () => {
    expect(parseSlashCommand("/yolo")).toEqual({ type: "yolo_status" });
    expect(parseSlashCommand("/yolo on")).toEqual({
      type: "yolo",
      enabled: true,
    });
    expect(parseSlashCommand("/yolo off")).toEqual({
      type: "yolo",
      enabled: false,
    });
    expect(() => parseSlashCommand("/yolo maybe")).toThrow("Usage: /yolo [on|off]");
  });

  test("parses the read-only skills panel command", () => {
    expect(parseSlashCommand("/skills")).toEqual({ type: "skills" });
    expect(() => parseSlashCommand("/skills activate")).toThrow("Unknown command");
  });

  test("parses the read-only MCP runtime inventory command", () => {
    expect(parseSlashCommand("/mcp")).toEqual({ type: "mcp" });
    expect(() => parseSlashCommand("/mcp verbose")).toThrow("Usage: /mcp");
  });

  test("parses the read-only memory browser without arguments", () => {
    expect(parseSlashCommand("/memory")).toEqual({ type: "memory" });
    expect(parseSlashCommand("/memory   ")).toEqual({ type: "memory" });
    expect(() => parseSlashCommand("/memory search")).toThrow("Usage: /memory");
    expect(matchSlashCommands("/mem").map((command) => command.name)).toEqual([
      "memory",
    ]);
  });

  test("keeps /compact swap-only and parses explicit prefix retirement", () => {
    expect(parseSlashCommand("/compact")).toEqual({ type: "compact" });
    expect(parseSlashCommand("/compact retire")).toEqual({
      type: "compact_retire",
    });
    expect(() => parseSlashCommand("/compact now")).toThrow("Usage: /compact [retire]");
    expect(() => parseSlashCommand("/compact --force")).toThrow(
      "Usage: /compact [retire]",
    );
  });

  test("parses /undo without arguments", () => {
    expect(parseSlashCommand("/undo")).toEqual({ type: "undo" });
    expect(parseSlashCommand("/undo   ")).toEqual({ type: "undo" });
    expect(() => parseSlashCommand("/undo list")).toThrow("Usage: /undo");
    expect(() => parseSlashCommand("/undo --force")).toThrow("Usage: /undo");
  });

  test("parses /clear without arguments", () => {
    expect(parseSlashCommand("/clear")).toEqual({ type: "clear" });
    expect(() => parseSlashCommand("/clear now")).toThrow("Usage: /clear");
  });

  test("parses /fork without arguments", () => {
    expect(parseSlashCommand("/fork")).toEqual({ type: "fork" });
    expect(() => parseSlashCommand("/fork extra")).toThrow("Usage: /fork");
  });

  test("parses /copy without arguments", () => {
    expect(parseSlashCommand("/copy")).toEqual({ type: "copy" });
    expect(() => parseSlashCommand("/copy now")).toThrow("Usage: /copy");
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
