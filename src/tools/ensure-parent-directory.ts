import { mkdir } from "node:fs/promises";
import path from "node:path";

export async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}
