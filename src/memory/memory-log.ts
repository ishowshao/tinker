import { lstat } from "node:fs/promises";
import path from "node:path";
import { appendPrivateFile } from "../events/append-private-file";
import type { MemoryDiagnostic } from "./contracts";

export class MemoryLog {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  append(record: MemoryDiagnostic): Promise<void> {
    const write = this.tail.then(async () => {
      if (!(await canAppendPrivately(this.filePath))) {
        return;
      }
      await appendPrivateFile(this.filePath, `${JSON.stringify(record)}\n`);
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
