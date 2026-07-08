import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_ENTRIES = 200;

export type PromptHistoryOptions = {
  filePath?: string;
  entries?: string[];
  maxEntries?: number;
};

export class PromptHistory {
  readonly filePath?: string;
  private readonly maxEntries: number;
  private items: string[];

  constructor(options: PromptHistoryOptions = {}) {
    this.filePath = options.filePath;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.items = trimToMax(options.entries ?? [], this.maxEntries);
  }

  static async load(
    filePath: string,
    options: { maxEntries?: number } = {},
  ): Promise<PromptHistory> {
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        return new PromptHistory({ filePath, maxEntries: options.maxEntries });
      }
      throw error;
    }

    const entries: string[] = [];
    for (const line of content.split("\n")) {
      if (line.trim() === "") {
        continue;
      }

      const parsed = parsePromptLine(line);
      if (parsed !== undefined) {
        entries.push(parsed);
      }
    }

    return new PromptHistory({ filePath, entries, maxEntries: options.maxEntries });
  }

  get entries(): readonly string[] {
    return this.items;
  }

  async append(prompt: string): Promise<void> {
    if (prompt === "" || this.items.at(-1) === prompt) {
      return;
    }

    this.items = trimToMax([...this.items, prompt], this.maxEntries);

    if (this.filePath === undefined) {
      return;
    }

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(prompt)}\n`, "utf8");
  }
}

function parsePromptLine(line: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "string" && parsed !== "" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function trimToMax(entries: string[], maxEntries: number): string[] {
  return entries.length > maxEntries
    ? entries.slice(entries.length - maxEntries)
    : entries;
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
