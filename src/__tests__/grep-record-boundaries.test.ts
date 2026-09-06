import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { DEFAULT_PUBLIC_TOOLING_CONFIG } from "../cli/public-config-contract";
import os from "node:os";
import path from "node:path";
import { ObservationBuilder } from "../observation/observation-builder";
import { createDefaultTooling } from "./helpers/tools-support";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-grep-records-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function search(
  tooling: ReturnType<typeof createDefaultTooling>,
  args: Record<string, unknown>,
) {
  const call = tooling.testRuntime.toolCall({ name: "Grep", args });
  const raw = await tooling.runtime.execute(call);
  if (raw.kind !== "grep") throw new Error("Expected Grep result");
  expect(raw.ok).toBe(true);
  return { raw, text: new ObservationBuilder().build({ call, raw }).displayText };
}

describe("Grep stable record boundaries", () => {
  test("content preserves multiline events and paginates selected matches with context", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(
        path.join(workspace, "a.txt"),
        "PAGE\nNEXT\ngap\ngap\nPAGE\nNEXT\n",
      );
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const full = await search(tooling, {
        pattern: "PAGE\\nNEXT",
        output_mode: "content",
        multiline: true,
      });
      expect(full.raw.content).toBe(
        "a.txt:1:PAGE\na.txt:2:NEXT\na.txt:5:PAGE\na.txt:6:NEXT",
      );
      const page = await search(tooling, {
        pattern: "PAGE",
        output_mode: "content",
        "-A": 1,
        offset: 1,
        head_limit: 1,
      });
      expect(page.raw.content).toBe("a.txt:5:PAGE\na.txt-6-NEXT");
      expect(page.raw.numFiles).toBe(1);
    });
  });

  test("malformed count protocol is surfaced as failure without fabricated counts", async () => {
    await withWorkspace(async (workspace) => {
      const executable = path.join(workspace, "fake-rg");
      await writeFile(
        executable,
        "#!/bin/sh\nprintf '/tmp/fake:999\\nreal.txt:1\\n'\n",
      );
      await chmod(executable, 0o755);
      const tooling = createDefaultTooling({
        workspaceRoot: workspace,
        toolingConfig: { ...DEFAULT_PUBLIC_TOOLING_CONFIG, ripgrepPath: executable },
      });
      const raw = await tooling.runtime.execute({
        name: "Grep",
        args: { pattern: "x", output_mode: "count-matches" },
      });
      expect(raw.ok).toBe(false);
      expect(raw).toMatchObject({
        numFiles: 0,
        error: "Invalid ripgrep output: Missing NUL path delimiter.",
      });
      expect("numMatches" in raw ? raw.numMatches : undefined).toBeUndefined();
    });
  });

  test("static five-file content pages have no duplicates or omissions", async () => {
    await withWorkspace(async (workspace) => {
      for (const name of ["e", "d", "c", "b", "a"]) {
        await writeFile(
          path.join(workspace, `${name}.txt`),
          name < "c" ? "PAGE\nPAGE\n" : "PAGE\n",
        );
      }
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const args = { pattern: "PAGE", output_mode: "content" };
      const expected = [
        "a.txt:1:PAGE",
        "a.txt:2:PAGE",
        "b.txt:1:PAGE",
        "b.txt:2:PAGE",
        "c.txt:1:PAGE",
        "d.txt:1:PAGE",
        "e.txt:1:PAGE",
      ];
      for (let run = 0; run < 6; run++) {
        expect((await search(tooling, { ...args, head_limit: 0 })).raw.content).toBe(
          expected.join("\n"),
        );
        const collected: string[] = [];
        let offset = 0;
        for (;;) {
          const { raw, text } = await search(tooling, {
            ...args,
            head_limit: 2,
            offset,
          });
          collected.push(...(raw.content ?? "").split("\n"));
          const next = /nextOffset=(\d+)/.exec(text);
          if (!next) break;
          offset = Number(next[1]);
          expect(offset).toBeLessThan(8);
        }
        expect(collected).toEqual(expected);
        expect(new Set(collected).size).toBe(7);
      }
    });
  });

  test("newline filenames stay single file records during pagination", async () => {
    await withWorkspace(async (workspace) => {
      const names = ["-dash.txt", "line\nbreak.txt"];
      for (const name of names) await writeFile(path.join(workspace, name), "PAGE\n");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const full = await search(tooling, { pattern: "PAGE" });
      expect(full.raw.numFiles).toBe(2);
      expect(full.raw.filenames).toEqual(names);
      expect(full.text).toContain('"line\\nbreak.txt"');
      const pages: string[] = [];
      for (const offset of [0, 1]) {
        const page = await search(tooling, { pattern: "PAGE", head_limit: 1, offset });
        expect(page.raw.numFiles).toBe(1);
        pages.push(...page.raw.filenames);
      }
      expect(pages).toEqual(names);
    });
  });

  test.each([
    "count",
    "count-matches",
  ])("%s cannot count digits embedded in filenames", async (mode) => {
    await withWorkspace(async (workspace) => {
      const names = ["fake:999\nreal.txt", "tab\tcarriage\r.txt", "literal\\n.txt"];
      for (const [i, name] of names.entries())
        await writeFile(
          path.join(workspace, name),
          i === 2 ? "COUNT_PROBE COUNT_PROBE\n" : "COUNT_PROBE\n",
        );
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const single = await search(tooling, {
        pattern: "COUNT_PROBE",
        path: names[0],
        output_mode: mode,
      });
      expect(single.raw.numFiles).toBe(1);
      expect(single.raw.numMatches).toBe(1);
      expect(single.text).toContain('"fake:999\\nreal.txt": 1');
      const full = await search(tooling, { pattern: "COUNT_PROBE", output_mode: mode });
      expect(full.raw.numFiles).toBe(3);
      expect(full.raw.numMatches).toBe(mode === "count" ? 3 : 4);
      expect(full.text).not.toContain("100");
      expect(full.text).not.toContain("\t");
      expect(full.text).not.toContain("\r");
      expect(full.text).toContain('"literal\\\\n.txt"');
      const pagePaths: string[] = [];
      let pageTotal = 0;
      for (const offset of [0, 1, 2]) {
        const page = await search(tooling, {
          pattern: "COUNT_PROBE",
          output_mode: mode,
          head_limit: 1,
          offset,
        });
        expect(page.raw.numFiles).toBe(1);
        expect(page.raw.counts).toHaveLength(1);
        pagePaths.push(...page.raw.filenames);
        pageTotal += page.raw.numMatches ?? 0;
      }
      expect(new Set(pagePaths)).toEqual(new Set(names));
      expect(pageTotal).toBe(mode === "count" ? 3 : 4);
    });
  });

  test("content records preserve unusual paths with and without line numbers", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(
        path.join(workspace, "fake:999\nreal.txt"),
        "before\nPAGE\nafter\n",
      );
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      for (const numbered of [true, false]) {
        const { raw, text } = await search(tooling, {
          pattern: "PAGE",
          output_mode: "content",
          "-n": numbered,
          context: 1,
        });
        expect(raw.numFiles).toBe(1);
        expect(raw.filenames).toEqual(["fake:999\nreal.txt"]);
        expect(raw.numLines).toBe(3);
        expect(text.split("\n")).toHaveLength(3);
        expect(text).toContain(
          numbered ? '"fake:999\\nreal.txt":2:PAGE' : '"fake:999\\nreal.txt":PAGE',
        );
      }
    });
  });
});
