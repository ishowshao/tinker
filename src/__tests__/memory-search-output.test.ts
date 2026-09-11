import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMemorySearchToolExecutor } from "../memory/memory-search-tool";
import { ensureMemoryDirectory } from "../memory/memory-files";
import { ObservationBuilder } from "../observation/observation-builder";
import { decodeStoredToolRawResult } from "../session/session-tool-result-codec";
import { createTestRuntime } from "./test-runtime";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tinker-literal-memory-"));
  const directory = await ensureMemoryDirectory(root);
  const executor = createMemorySearchToolExecutor({ homeRoot: root });
  return {
    root,
    directory,
    async search(args: unknown, signal = new AbortController().signal) {
      const call = createTestRuntime().toolCall({ name: "MemorySearch", args });
      const result = await executor.execute(args, call, { signal });
      const raw = decodeStoredToolRawResult(JSON.parse(JSON.stringify(result)));
      return { raw, text: new ObservationBuilder().build({ call, raw }).displayText };
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("literal memory search groups persisted passages and paginates across files", async () => {
  const f = await fixture();
  try {
    const first = path.join(f.directory, "a:1-notes.md");
    const second = path.join(f.directory, 'b"notes.md');
    await writeFile(
      first,
      "before\r\nneedle one\r\nafter\r\nskip\r\nskip\r\nbefore two\r\nNEEDLE two\r\nafter two\r\n",
    );
    await writeFile(second, "needle three\nlast\nneedle four");
    const { raw, text } = await f.search({
      keywords: ["needle", "one"],
      context: 1,
      limit: 3,
    });
    expect(text).toBe(
      [
        `File: ${first}`,
        "",
        "  1 | before",
        "> 2 | needle one",
        "  3 | after",
        "",
        "…",
        "",
        "  6 | before two",
        "> 7 | NEEDLE two",
        "  8 | after two",
        "",
        `File: ${JSON.stringify(second)}`,
        "",
        "> 1 | needle three",
        "  2 | last",
        "",
        "More results available; nextOffset=3.",
      ].join("\n"),
    );
    expect(raw).toMatchObject({
      ok: true,
      format: "text",
      returnedResults: 3,
      hasMore: true,
      nextOffset: 3,
    });
    const last = await f.search({
      keywords: ["needle"],
      context: 1,
      limit: 3,
      offset: 3,
    });
    expect(last.text).toBe(
      [
        `File: ${JSON.stringify(second)}`,
        "",
        "  2 | last",
        "> 3 | needle four",
        "",
        "End of results.",
      ].join("\n"),
    );
  } finally {
    await f.cleanup();
  }
});

test("memory search treats regex punctuation literally, supports short Chinese keywords and only reads Markdown", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.directory, "notes"));
    await writeFile(
      path.join(f.directory, "notes", "a.md"),
      "a.b and [X]\naxb\n记忆\nnone\n",
    );
    await writeFile(path.join(f.directory, "ignored.txt"), "a.b");
    await writeFile(path.join(f.root, "outside.md"), "a.b");
    await symlink(path.join(f.root, "outside.md"), path.join(f.directory, "linked.md"));
    const { raw, text } = await f.search({
      keywords: ["A.B", "[x]", "记忆"],
      context: 0,
    });
    expect(raw).toMatchObject({ ok: true, returnedResults: 2, hasMore: false });
    expect(text).toContain("> 1 | a.b and [X]\n\n…\n\n> 3 | 记忆");
    expect(text).not.toContain("axb");
    expect(text).not.toContain("outside");
    const empty = await f.search({ keywords: ["a.b|记忆"] });
    expect(empty.raw).toMatchObject({
      ok: true,
      returnedResults: 0,
      files: [],
      hasMore: false,
    });
  } finally {
    await f.cleanup();
  }
});

test("memory search defaults to 20 hits with three context lines and merges overlap", async () => {
  const f = await fixture();
  try {
    const file = path.join(f.directory, "notes.md");
    await writeFile(
      file,
      Array.from({ length: 240 }, (_, n) =>
        n % 10 === 5 ? `needle ${n}` : `context ${n}`,
      ).join("\n"),
    );
    const first = await f.search({ keywords: ["needle"] });
    expect(first.raw).toMatchObject({ ok: true, returnedResults: 20, nextOffset: 20 });
    expect(first.text).toContain(
      "  3 | context 2\n  4 | context 3\n  5 | context 4\n> 6 | needle 5\n  7 | context 6\n  8 | context 7\n  9 | context 8",
    );
    const last = await f.search({ keywords: ["needle"], offset: 20 });
    expect(last.raw).toMatchObject({ ok: true, returnedResults: 4, hasMore: false });
    expect((await f.search({ keywords: ["needle"], offset: 24 })).raw).toMatchObject({
      ok: true,
      returnedResults: 0,
    });
    await writeFile(file, "start\nneedle one\nneedle two\nend\n");
    expect((await f.search({ keywords: ["needle"], context: 1 })).text).toBe(
      `File: ${file}\n\n  1 | start\n> 2 | needle one\n> 3 | needle two\n  4 | end\n\nEnd of results.`,
    );
    const page = await f.search({ keywords: ["needle"], context: 1, limit: 1 });
    expect(page.text).toContain("> 3 | needle two");
    expect(page.raw).toMatchObject({
      returnedResults: 1,
      nextOffset: 1,
      hasMore: true,
    });
  } finally {
    await f.cleanup();
  }
});

test("memory search excerpts long Unicode lines around a literal match and rejects obsolete arguments", async () => {
  const f = await fixture();
  try {
    await writeFile(
      path.join(f.directory, "long.md"),
      `${"İ😀".repeat(400)}记忆${"尾".repeat(700)}\n`,
    );
    const result = await f.search({ keywords: ["记忆"] });
    expect(result.text).toContain("记忆");
    expect(result.text).toContain("code points omitted");
    expect(result.text.length).toBeLessThan(1000);
    for (const args of [
      null,
      {},
      { keywords: [] },
      { keywords: [""] },
      { keywords: ["a\nb"] },
      { keywords: [1] },
      { keywords: ["ok"], pattern: "ok" },
      { keywords: ["ok"], limit: 0 },
      { keywords: ["ok"], offset: -1 },
      { keywords: ["ok"], context: 1.5 },
      { keywords: ["ok"], path: "/" },
    ]) {
      expect((await f.search(args)).raw).toMatchObject({ ok: false });
    }
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const cancellation = await f
      .search({ keywords: ["记忆"] }, controller.signal)
      .catch((error: unknown) => error);
    expect(cancellation).toBe(controller.signal.reason);
  } finally {
    await f.cleanup();
  }
});
