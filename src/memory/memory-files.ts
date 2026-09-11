import { defaultHomeRoot } from "../session/workspace-storage";
import path from "node:path";
import { access, mkdir, open, readdir, rename, writeFile } from "node:fs/promises";
import { createUuidV7 } from "../ids/uuid-v7";
import { throwIfTurnCancelled } from "../agent/turn-cancellation";
import type { ToolExecutor } from "../tools/types";
import { boundedMemoryError, type StoredMemorySummary } from "./contracts";
import { createMemoryCreateToolExecutor } from "./memory-create-tool";

export function memoryDirectory(homeRoot = defaultHomeRoot()): string {
  return path.resolve(homeRoot, ".tinker", "memory");
}

export function sessionMemoryPath(sessionId: string, homeRoot?: string): string {
  return path.join(memoryDirectory(homeRoot), "records", `${sessionId}.md`);
}

/** Old database and diagnostic files are retained outside the searchable directory. */
export async function ensureMemoryDirectory(homeRoot?: string): Promise<string> {
  const directory = memoryDirectory(homeRoot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const legacy = (await readdir(directory)).filter((name) =>
    [
      "memory.sqlite",
      "memory.sqlite-wal",
      "memory.sqlite-shm",
      "memory-log.jsonl",
      "extracted-memories.log",
    ].includes(name),
  );
  if (legacy.length > 0) {
    const archive = path.join(path.dirname(directory), "memory-legacy", createUuidV7());
    await mkdir(archive, { recursive: true, mode: 0o700 });
    for (const name of legacy) {
      await rename(path.join(directory, name), path.join(archive, name)).catch(
        (error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        },
      );
    }
  }
  return directory;
}

export function createFileMemoryCreateToolExecutor(input: {
  workspaceRoot: string;
  homeRoot?: string;
  clock?: () => string;
}): ToolExecutor {
  return createMemoryCreateToolExecutor({
    async create(text, summary, _call, signal) {
      throwIfTurnCancelled(signal);
      try {
        const directory = path.join(
          await ensureMemoryDirectory(input.homeRoot),
          "notes",
        );
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const memoryId = createUuidV7();
        const createdAt = (input.clock ?? (() => new Date().toISOString()))();
        const filePath = path.join(directory, `${memoryId}.md`);
        const title = text.replaceAll(/\s*\r?\n\s*/g, " ");
        const heading = title.startsWith("# ") ? title : `# ${title}`;
        const markdown = `${heading}\n\nCreated: ${createdAt}\nWorkspace: ${input.workspaceRoot}\n${summary === "" ? "" : `\n${summary}\n`}`;
        throwIfTurnCancelled(signal);
        await writeFile(filePath, markdown, { flag: "wx", mode: 0o600 });
        return { ok: true, status: "created", memoryId, createdAt, filePath };
      } catch (error) {
        throwIfTurnCancelled(signal);
        return { ok: false, error: boundedMemoryError(error) };
      }
    },
  });
}

/** The browser shows a bounded preview; Read can open the complete file. */
export async function listMemoryFiles(
  homeRoot?: string,
): Promise<readonly StoredMemorySummary[]> {
  const directory = await ensureMemoryDirectory(homeRoot);
  const memories: StoredMemorySummary[] = [];
  for (const folder of ["notes", "records"]) {
    const entries = await readdir(path.join(directory, folder), {
      withFileTypes: true,
    }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const filePath = path.join(directory, folder, entry.name);
      const handle = await open(filePath, "r");
      let content: string;
      try {
        const buffer = Buffer.alloc(4_096);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        content = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
      const lines = content.split("\n");
      const id = entry.name.slice(0, -3);
      memories.push({
        memoryId: id,
        text: lines[0]?.replace(/^# /, "") ?? entry.name,
        summary: lines
          .slice(1)
          .filter(
            (line) => !/^(Created|Started|Workspace|Model|Max iterations): /.test(line),
          )
          .join("\n")
          .trim(),
        sourceWorkspace: /^Workspace: (.*)$/m.exec(content)?.[1] ?? "",
        sourceSessionId: folder === "records" ? id : "",
        createdAt: /^(?:Created|Started): (.*)$/m.exec(content)?.[1] ?? "",
      });
    }
  }
  return memories.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.memoryId.localeCompare(a.memoryId),
  );
}

/** Move an older session-local transcript when reopening or publishing a clone. */
export async function prepareSessionMemory(
  sessionDirectory: string,
  sessionId: string,
  homeRoot?: string,
): Promise<void> {
  const directory = await ensureMemoryDirectory(homeRoot);
  await mkdir(path.join(directory, "records"), { recursive: true, mode: 0o700 });
  const target = sessionMemoryPath(sessionId, homeRoot);
  try {
    await access(target);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(path.join(sessionDirectory, "observations.md"), target).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    },
  );
}
