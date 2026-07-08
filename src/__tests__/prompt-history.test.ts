import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PromptHistory } from "../tui/prompt-history";

async function tempHistoryPath(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tinker-history-"));
  return path.join(dir, "nested", "prompt-history.jsonl");
}

describe("prompt history", () => {
  test("loads an empty history when the file does not exist", async () => {
    const history = await PromptHistory.load(await tempHistoryPath());
    expect(history.entries).toEqual([]);
  });

  test("appends entries and persists them across loads", async () => {
    const filePath = await tempHistoryPath();
    const history = await PromptHistory.load(filePath);

    await history.append("first prompt");
    await history.append("second\nmultiline prompt");
    expect(history.entries).toEqual(["first prompt", "second\nmultiline prompt"]);

    const reloaded = await PromptHistory.load(filePath);
    expect(reloaded.entries).toEqual(["first prompt", "second\nmultiline prompt"]);
  });

  test("skips consecutive duplicates and empty prompts", async () => {
    const filePath = await tempHistoryPath();
    const history = await PromptHistory.load(filePath);

    await history.append("same");
    await history.append("same");
    await history.append("");
    await history.append("other");
    await history.append("same");
    expect(history.entries).toEqual(["same", "other", "same"]);

    const reloaded = await PromptHistory.load(filePath);
    expect(reloaded.entries).toEqual(["same", "other", "same"]);
  });

  test("skips corrupt lines when loading", async () => {
    const filePath = await tempHistoryPath();
    const history = await PromptHistory.load(filePath);
    await history.append("valid");

    await writeFile(
      filePath,
      `${await readFile(filePath, "utf8")}not json\n{"object":true}\n"also valid"\n`,
      "utf8",
    );

    const reloaded = await PromptHistory.load(filePath);
    expect(reloaded.entries).toEqual(["valid", "also valid"]);
  });

  test("keeps only the most recent entries beyond maxEntries", async () => {
    const filePath = await tempHistoryPath();
    const history = new PromptHistory({ filePath, maxEntries: 2 });

    await history.append("one");
    await history.append("two");
    await history.append("three");
    expect(history.entries).toEqual(["two", "three"]);

    const reloaded = await PromptHistory.load(filePath, { maxEntries: 2 });
    expect(reloaded.entries).toEqual(["two", "three"]);
  });

  test("works in memory without a file path", async () => {
    const history = new PromptHistory();
    await history.append("only in memory");
    expect(history.entries).toEqual(["only in memory"]);
  });
});
