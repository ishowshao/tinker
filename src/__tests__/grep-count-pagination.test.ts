import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ObservationBuilder } from "../observation/observation-builder";
import { buildRipgrepArgs } from "../tools/grep";
import type { GrepOutputMode, GrepRawResult } from "../tools/types";
import { createDefaultTooling } from "./helpers/tools-support";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";
import { createTestRuntime } from "./test-runtime";

isolateTinkerHome();

async function withWorkspace(callback: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-grep-count-"));
  try {
    await callback(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function observe(raw: GrepRawResult): string {
  const call = createTestRuntime().toolCall({ name: "Grep", args: {} });
  return new ObservationBuilder().build({ call, raw: { ...raw, kind: "grep" } })
    .displayText;
}

async function search(
  tooling: ReturnType<typeof createDefaultTooling>,
  args: Record<string, unknown>,
) {
  const call = tooling.testRuntime.toolCall({ name: "Grep", args });
  const raw = await tooling.runtime.execute(call);
  if (raw.kind !== "grep") throw new Error("Expected Grep result");
  return { raw, text: observe(raw) };
}

const modes: ("count" | "count-matches")[] = ["count", "count-matches"];
const allModes: GrepOutputMode[] = ["files_with_matches", "content", ...modes];

describe("Grep counting contracts", () => {
  test("exposes both native counting modes and their restrictions", async () => {
    await withWorkspace(async (workspace) => {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const schema = tooling.registry
        .definitions()
        .find((tool) => tool.name === "Grep")?.parameters;
      expect(schema?.properties).toMatchObject({
        output_mode: {
          enum: ["content", "files_with_matches", "count", "count-matches"],
        },
      });
      expect(JSON.stringify(schema)).toContain("non-overlapping matches per file");
      expect(JSON.stringify(schema)).toContain(
        "cannot be combined with multiline=true",
      );
      for (const mode of modes) {
        const args = buildRipgrepArgs({ pattern: "repeat" }, mode, workspace);
        expect(args).toContain(mode === "count" ? "-c" : "--count-matches");
        expect(args).not.toContain(mode === "count" ? "--count-matches" : "-c");
        expect(args).toContain("--with-filename");
      }
    });
  });

  test.each(modes)("%s distinguishes repeated matches on one line", async (mode) => {
    await withWorkspace(async (workspace) => {
      await writeFile(
        path.join(workspace, "count:fixture.txt"),
        "repeat repeat repeat\nrepeat\n",
      );
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const { raw, text } = await search(tooling, {
        pattern: "repeat",
        path: "count:fixture.txt",
        output_mode: mode,
      });
      const count = mode === "count" ? 2 : 4;
      const unit = mode === "count" ? "matching lines" : "matches";
      expect(raw).toMatchObject({
        ok: true,
        mode,
        numMatches: count,
        numFiles: 1,
        totalResults: 1,
      });
      expect(text).toBe(
        `count:fixture.txt: ${count} ${unit}\n\nTotal: ${count} ${unit} across 1 matching file.`,
      );
      expect(text).not.toContain("occurrences");
    });
  });

  test("rejects multiline count before searching and suggests count-matches", async () => {
    await withWorkspace(async (workspace) => {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const { raw, text } = await search(tooling, {
        pattern: "repeat",
        output_mode: "count",
        multiline: true,
      });
      expect(raw.ok).toBe(false);
      expect(text).toContain(
        'cannot be combined with multiline=true. Use output_mode="count-matches"',
      );
      const invalid = await search(tooling, {
        pattern: "repeat",
        output_mode: "counts",
      });
      expect(invalid.raw.ok).toBe(false);
      expect(invalid.text).toContain('"count-matches"');
    });
  });

  test("count-matches supports multiline matches and same-line non-overlapping matches", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.txt"), "repeat repeat repeat\nrepeat\n");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const spanning = await search(tooling, {
        pattern: "repeat\nrepeat",
        output_mode: "count-matches",
        multiline: true,
      });
      expect(spanning.text).toBe(
        "a.txt: 1 match\n\nTotal: 1 match across 1 matching file.",
      );
      const sameLine = await search(tooling, {
        pattern: "repeat",
        output_mode: "count-matches",
        multiline: true,
      });
      expect(sameLine.raw.numMatches).toBe(4);
      await writeFile(path.join(workspace, "overlap.txt"), "aaaa\n");
      const overlap = await search(tooling, {
        pattern: "aa",
        path: "overlap.txt",
        output_mode: "count-matches",
      });
      expect(overlap.raw.numMatches).toBe(2);
    });
  });

  test.each(
    modes,
  )("%s labels full totals and every partial page accurately", async (mode) => {
    await withWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.txt"), "repeat repeat repeat\nrepeat\n");
      await writeFile(path.join(workspace, "b.txt"), "repeat\n");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const args = { pattern: "repeat", output_mode: mode };
      const full = await search(tooling, { ...args, head_limit: 0 });
      expect(full.text).toContain(
        mode === "count"
          ? "Total: 3 matching lines across 2 matching files."
          : "Total: 5 matches across 2 matching files.",
      );
      const first = await search(tooling, { ...args, head_limit: 1 });
      expect(first.text).toContain(
        mode === "count"
          ? "This page: 2 matching lines across 1 matching file."
          : "This page: 4 matches across 1 matching file.",
      );
      expect(first.text).toContain("More results available; nextOffset=1.");
      expect(first.text).not.toContain("Total:");
      for (const head_limit of [0, 1, 100]) {
        const last = await search(tooling, { ...args, offset: 1, head_limit });
        expect(last.text).toContain(
          mode === "count"
            ? "This page: 1 matching line across 1 matching file."
            : "This page: 1 match across 1 matching file.",
        );
        expect(last.text).toEndWith("End of results.");
        expect(last.text).not.toContain("Total:");
        expect(last.text).not.toContain("nextOffset");
      }
    });
  });
});

describe("Grep pagination observations", () => {
  test.each(
    allModes,
  )("%s distinguishes an exhausted page from a search with no matches", async (mode) => {
    await withWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.txt"), "repeat\nrepeat\n");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const args = { output_mode: mode, offset: 99, head_limit: 1 };
      const emptyPage = await search(tooling, { ...args, pattern: "repeat" });
      expect(emptyPage.raw.ok).toBe(true);
      expect(emptyPage.text).toBe(
        "No results on this page at offset 99.\n\nEnd of results.",
      );
      const noMatch = await search(tooling, { ...args, pattern: "missing" });
      expect(noMatch.text).toBe("No matches found");
      expect(noMatch.raw.totalResults).toBe(0);
    });
  });

  test("content pagination gives a usable continuation offset", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.txt"), "repeat\nrepeat\nrepeat\n");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const { text } = await search(tooling, {
        pattern: "repeat",
        output_mode: "content",
        offset: 1,
        head_limit: 1,
      });
      expect(text).toBe("a.txt:2:repeat\n\nMore results available; nextOffset=2.");
    });
  });

  test.each(
    modes,
  )("%s never claims global totals for incomplete search output", (mode) => {
    const raw: GrepRawResult = {
      ok: true,
      pattern: "repeat",
      searchPath: ".",
      mode,
      filenames: ["a.txt"],
      numFiles: 1,
      content: "a.txt:2",
      numMatches: 2,
      totalResults: 1,
      truncated: true,
      error: "ripgrep timed out.",
    };
    const text = observe(raw);
    expect(text).toContain("Results shown: 2");
    expect(text).toContain("Warning: results are incomplete. ripgrep timed out.");
    expect(text).not.toContain("Total:");
    const page = observe({ ...raw, appliedLimit: 1, totalResults: 2 });
    expect(page).toContain("This page: 2");
    expect(page).toContain("More collected results available; nextOffset=1.");
    const emptyPage = observe({
      ...raw,
      appliedOffset: 99,
      filenames: [],
      numFiles: 0,
      content: "",
      numMatches: 0,
    });
    expect(emptyPage).toContain("No results on this page at offset 99.");
    expect(emptyPage).toContain("End of collected results; search is incomplete.");
    expect(emptyPage).not.toContain("No matches found");
  });
});
