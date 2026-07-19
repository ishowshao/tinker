import clipboard from "clipboardy";

export async function writeClipboardText(text: string): Promise<void> {
  await clipboard.write(text);
}
