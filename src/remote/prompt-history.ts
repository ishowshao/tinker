import { PromptHistory } from "../tui/prompt-history";
import { validatePromptDraft, type PromptDraft } from "../tui/prompt-draft";
import { promptHistoryPath } from "../cli/config";
import { RemoteError, requireObject } from "./protocol";

const pending = new Map<string, Promise<void>>();
export async function readPromptHistory(workspaceRoot: string, homeRoot?: string) {
  const filename = await promptHistoryPath(workspaceRoot, homeRoot);
  await pending.get(filename);
  return (await PromptHistory.load(filename)).records;
}
export async function appendPromptHistory(
  request: Request,
  workspaceRoot: string,
  homeRoot?: string,
): Promise<void> {
  const body = await request.text();
  if (Buffer.byteLength(body) > 96 * 1024)
    throw new RemoteError(413, "BODY_TOO_LARGE", "Prompt history entry is too large.");
  const input = requireObject(JSON.parse(body));
  const prompt = input.prompt as string | PromptDraft;
  if (typeof prompt !== "string") validatePromptDraft(prompt);
  const filename = await promptHistoryPath(workspaceRoot, homeRoot);
  const next = (pending.get(filename) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const history = await PromptHistory.load(filename);
      await history.append(prompt);
    });
  pending.set(filename, next);
  try {
    await next;
  } finally {
    if (pending.get(filename) === next) pending.delete(filename);
  }
}
