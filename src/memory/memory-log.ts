import { lstat } from "node:fs/promises";
import path from "node:path";
import { appendPrivateFile } from "../events/append-private-file";
import type { MemoryDiagnostic, MemoryInsertedRecord } from "./contracts";

export class MemoryLog {
  private readonly writer: PrivateLogWriter;

  constructor(filePath: string) {
    this.writer = new PrivateLogWriter(filePath);
  }

  append(record: MemoryDiagnostic): Promise<void> {
    return this.writer.append(`${JSON.stringify(record)}\n`);
  }
}

export class ExtractedMemoryLog {
  private readonly writer: PrivateLogWriter;

  constructor(filePath: string) {
    this.writer = new PrivateLogWriter(filePath);
  }

  append(input: {
    readonly at: string;
    readonly workspace: string;
    readonly turnId: string;
    readonly memories: readonly MemoryInsertedRecord[];
  }): Promise<void> {
    if (input.memories.length === 0) {
      return Promise.resolve();
    }
    const lines = [
      `[${input.at}] workspace=${JSON.stringify(input.workspace)} turn=${input.turnId} written=${input.memories.length}`,
      ...input.memories.map(
        (memory) => `- ${memory.memoryId} | ${JSON.stringify(memory.text)}`,
      ),
    ];
    return this.writer.append(`${lines.join("\n")}\n\n`);
  }
}

class PrivateLogWriter {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  append(content: string): Promise<void> {
    const write = this.tail.then(async () => {
      if (!(await canAppendPrivately(this.filePath))) {
        return;
      }
      await appendPrivateFile(this.filePath, content);
    });
    this.tail = write.catch(() => undefined);
    return write.catch(() => undefined);
  }
}

async function canAppendPrivately(filePath: string): Promise<boolean> {
  const directory = path.dirname(filePath);
  const directoryState = await lstat(directory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    },
  );
  if (
    directoryState !== undefined &&
    (!directoryState.isDirectory() || (directoryState.mode & 0o777) !== 0o700)
  ) {
    return false;
  }

  const fileState = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  return (
    fileState === undefined ||
    (fileState.isFile() && (fileState.mode & 0o777) === 0o600)
  );
}
