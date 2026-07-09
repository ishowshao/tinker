import { describe, expect, test } from "bun:test";
import {
  findSlashCommand,
  matchSlashCommands,
  SLASH_COMMANDS,
  type SlashCommand,
} from "../tui/slash-commands";

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
