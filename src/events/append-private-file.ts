import path from "node:path";
import { chmod, mkdir, open } from "node:fs/promises";

export async function appendPrivateFile(
  filePath: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await open(filePath, "a", 0o600);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(filePath, 0o600);
}
