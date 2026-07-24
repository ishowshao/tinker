import clipboard from "clipboardy";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeClipboardText(text: string): Promise<void> {
  await clipboard.write(text);
}

export function clipboardWriterForEnvironment(
  env: NodeJS.ProcessEnv,
): ((text: string) => Promise<void>) | undefined {
  const filePath = env.TINKER_TEST_CLIPBOARD_FILE;
  if (filePath === undefined || filePath === "") {
    return undefined;
  }
  if (env.TINKER_TEST_FAKE_MODEL === undefined || env.TINKER_TEST_FAKE_MODEL === "") {
    throw new Error("TINKER_TEST_CLIPBOARD_FILE requires TINKER_TEST_FAKE_MODEL.");
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error("TINKER_TEST_CLIPBOARD_FILE must be an absolute path.");
  }
  return (text) =>
    writeFile(filePath, text, {
      encoding: "utf8",
      mode: 0o600,
    });
}
