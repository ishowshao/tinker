import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ObservationBuilder } from "../observation/observation-builder";
import { decodeStoredToolRawResult } from "../session/session-tool-result-codec";
import { createDefaultTooling } from "./helpers/tools-support";
import { isolateTinkerHome } from "./helpers/workspace-storage-test-support";

isolateTinkerHome();

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "tinker-glob-page-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe("Glob pagination and errors", () => {
  test("pages sorted results without omissions and preserves pages through storage decoding", async () => {
    await withWorkspace(async (workspace) => {
      const names = Array.from(
        { length: 503 },
        (_, i) => `${String(i).padStart(3, "0")}.ts`,
      );
      await Promise.all(
        [...names].reverse().map((name) => writeFile(path.join(workspace, name), "")),
      );
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const builder = new ObservationBuilder();
      const collected: string[] = [];
      for (const offset of [0, 200, 400]) {
        const call = tooling.testRuntime.toolCall({
          providerToolCallId: `page_${offset}`,
          name: "Glob",
          args: { pattern: "*.ts", offset },
        });
        const raw = await tooling.runtime.execute(call);
        expect(raw.kind).toBe("glob");
        if (raw.kind !== "glob") throw new Error("Expected Glob result");
        const expectedPage = names.slice(offset, offset + 200);
        expect(raw).toMatchObject({
          ok: true,
          matches: expectedPage,
          matchCount: expectedPage.length,
          totalMatches: 503,
          returnedCount: expectedPage.length,
          appliedOffset: offset,
          hasMore: offset < 400,
        });
        expect(raw.nextOffset).toBe(offset < 400 ? offset + 200 : undefined);
        collected.push(...(raw.matches ?? []));
        const restored = decodeStoredToolRawResult(JSON.parse(JSON.stringify(raw)));
        expect(restored).toEqual(raw);
        const text = builder.build({ call, raw: restored }).displayText;
        expect(text).toContain(
          `totalMatches=503\nreturnedCount=${expectedPage.length}\nhasMore=${offset < 400}`,
        );
        expect(text.split("matches:\n")[1]).toBe(expectedPage.join("\n"));
        if (offset < 400) expect(text).toContain(`nextOffset=${offset + 200}`);
        else expect(text).not.toContain("nextOffset=");
      }
      expect(collected).toEqual(names);

      for (const [head_limit, count] of [
        [1, 1],
        [500, 500],
      ]) {
        const raw = await tooling.runtime.execute({
          providerToolCallId: `limit_${head_limit}`,
          name: "Glob",
          args: { pattern: "*.ts", head_limit },
        });
        expect(raw).toMatchObject({
          ok: true,
          returnedCount: count,
          nextOffset: count,
        });
      }
      const exact = await tooling.runtime.execute({
        providerToolCallId: "exact",
        name: "Glob",
        args: { pattern: "*.ts", offset: 3, head_limit: 500 },
      });
      expect(exact).toMatchObject({ ok: true, returnedCount: 500, hasMore: false });
      expect(exact).not.toHaveProperty("nextOffset");
    });
  });

  test("distinguishes empty searches from offsets at or beyond the end", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(path.join(workspace, "a.ts"), "");
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      for (const [pattern, offset, totalMatches, message] of [
        ["*.md", 0, 0, "(no matches)"],
        ["*.md", 9, 0, "(no matches)"],
        ["*.ts", 1, 1, "(no results on this page at offset 1)"],
        [
          "*.ts",
          Number.MAX_SAFE_INTEGER,
          1,
          `(no results on this page at offset ${Number.MAX_SAFE_INTEGER})`,
        ],
      ] as const) {
        const call = tooling.testRuntime.toolCall({
          providerToolCallId: `empty_${pattern}_${offset}`,
          name: "Glob",
          args: { pattern, offset },
        });
        const raw = await tooling.runtime.execute(call);
        expect(raw).toMatchObject({
          ok: true,
          matches: [],
          totalMatches,
          returnedCount: 0,
          hasMore: false,
        });
        expect(raw).not.toHaveProperty("nextOffset");
        expect(new ObservationBuilder().build({ call, raw }).displayText).toContain(
          message,
        );
      }
    });
  });

  test("rejects invalid pagination and preserves the supplied pattern and search path", async () => {
    await withWorkspace(async (workspace) => {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      for (const [parameter, values] of [
        ["head_limit", [0, -1, 501, 1.5, "200", null, NaN, Infinity]],
        ["offset", [-1, 0.5, "0", null, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]],
      ] as const) {
        for (const value of values) {
          const call = tooling.testRuntime.toolCall({
            providerToolCallId: `bad_${parameter}_${value}`,
            name: "Glob",
            args: { pattern: "*.ts", path: "src", [parameter]: value },
          });
          const raw = await tooling.runtime.execute(call);
          expect(raw).toMatchObject({ ok: false, pattern: "*.ts", searchPath: "src" });
          const text = new ObservationBuilder().build({ call, raw }).displayText;
          expect(text).toContain('pattern="*.ts", searchPath="src"');
          expect(text).toContain(`Glob.${parameter} must be`);
        }
      }
      for (const args of [
        { pattern: "/tmp/*.ts", path: "src" },
        { pattern: "../*", path: "src" },
        { pattern: "*.ts", path: 123 },
        { pattern: "*.ts", path: "missing" },
        { pattern: "", path: "src" },
      ]) {
        const call = tooling.testRuntime.toolCall({
          providerToolCallId: `error_${args.pattern}_${args.path}`,
          name: "Glob",
          args,
        });
        const raw = await tooling.runtime.execute(call);
        expect(raw).toMatchObject({ ok: false, pattern: args.pattern });
        expect(new ObservationBuilder().build({ call, raw }).displayText).toContain(
          `pattern=${JSON.stringify(args.pattern)}`,
        );
      }
      for (const args of [{}, { pattern: 123 }]) {
        const call = tooling.testRuntime.toolCall({
          providerToolCallId: `missing_${JSON.stringify(args)}`,
          name: "Glob",
          args,
        });
        const raw = await tooling.runtime.execute(call);
        expect(raw.ok).toBe(false);
        expect(new ObservationBuilder().build({ call, raw }).displayText).toContain(
          "pattern=(missing or invalid)",
        );
      }
    });
  });

  test("renders stored legacy results with their full count", async () => {
    await withWorkspace(async (workspace) => {
      const tooling = createDefaultTooling({ workspaceRoot: workspace });
      const call = tooling.testRuntime.toolCall({
        providerToolCallId: "legacy",
        name: "Glob",
        args: { pattern: "*.ts" },
      });
      const raw = decodeStoredToolRawResult({
        kind: "glob",
        ok: true,
        pattern: "*.ts",
        searchPath: ".",
        matches: ["a.ts"],
        matchCount: 1,
      });
      expect(new ObservationBuilder().build({ call, raw }).displayText).toContain(
        "totalMatches=1\nreturnedCount=1\nhasMore=false",
      );
    });
  });
});
