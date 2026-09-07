import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const runner = path.resolve(import.meta.dir, "../../scripts/run-test-shards.ts");

test.each([
  false,
  true,
])("test shards cover every file once, forward filters, and propagate failure=%s", async (fail) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tinker-test-shards-"));
  const seen = path.join(root, "seen.jsonl");
  try {
    for (let index = 0; index < 8; index++) {
      await writeFile(
        path.join(root, `fixture-${index}.test.ts`),
        `import { test, expect } from "bun:test";
import { appendFileSync } from "node:fs";
test("included", async () => {
  await Bun.sleep(${index * 5});
  appendFileSync(${JSON.stringify(seen)}, ${JSON.stringify(`${index}\n`)});
  expect(${fail && index === 0 ? "false" : "true"}).toBe(true);
});
test("excluded", () => { throw new Error("test filter was not forwarded"); });
`,
      );
    }
    const child = Bun.spawn(
      [process.execPath, runner, root, "--test-name-pattern", "included"],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({
      code,
      diagnostic: code === (fail ? 1 : 0) ? "" : stdout + stderr,
    }).toEqual({
      code: fail ? 1 : 0,
      diagnostic: "",
    });
    expect(
      (await readFile(seen, "utf8")).trim().split("\n").map(Number).sort(),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (let shard = 1; shard <= 4; shard++) {
      expect(stderr).toContain(`Test shard ${shard}/4:`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
