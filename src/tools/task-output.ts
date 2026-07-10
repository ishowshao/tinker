import { mkdir } from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export type TaskOutputSnapshot = {
  outputBytes: number;
  outputLines: number;
  preview: string;
  truncated: boolean;
  omittedLines?: number;
};

const maxPreviewLines = 200;
const previewEdgeLines = 100;

export class TaskOutput {
  private readonly decoder = new StringDecoder("utf8");
  private readonly stream: WriteStream;
  private outputBytes = 0;
  private outputLines = 0;
  private pendingLine = "";
  private fullPreviewLines: string[] | undefined = [];
  private readonly firstLines: string[] = [];
  private readonly lastLines: string[] = [];
  private endPromise?: Promise<TaskOutputSnapshot>;

  private constructor(readonly filePath: string) {
    this.stream = createWriteStream(filePath, { flags: "a" });
  }

  static async create(filePath: string): Promise<TaskOutput> {
    await mkdir(path.dirname(filePath), { recursive: true });
    return new TaskOutput(filePath);
  }

  write(chunk: Buffer): void {
    this.outputBytes += chunk.byteLength;
    this.stream.write(chunk);
    this.appendText(this.decoder.write(chunk));
  }

  async end(): Promise<TaskOutputSnapshot> {
    this.endPromise ??= this.finish();
    return this.endPromise;
  }

  private async finish(): Promise<TaskOutputSnapshot> {
    this.appendText(this.decoder.end());
    if (this.pendingLine !== "") {
      this.pushLine(this.pendingLine);
      this.pendingLine = "";
    }

    await new Promise<void>((resolve, reject) => {
      this.stream.end((error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    return this.snapshot();
  }

  snapshot(): TaskOutputSnapshot {
    const outputLines = this.outputLines + (this.pendingLine === "" ? 0 : 1);
    const lines = this.previewLines();

    if (outputLines <= maxPreviewLines) {
      return {
        outputBytes: this.outputBytes,
        outputLines,
        preview: lines.join("\n"),
        truncated: false,
      };
    }

    const omittedLines = outputLines - maxPreviewLines;
    return {
      outputBytes: this.outputBytes,
      outputLines,
      preview: [
        ...this.firstLines,
        `... output omitted: ${omittedLines} lines omitted. Full output is available at outputFilePath.`,
        ...this.lastPreviewLines(),
      ].join("\n"),
      truncated: true,
      omittedLines,
    };
  }

  private appendText(text: string): void {
    if (text === "") {
      return;
    }

    const parts = text.split("\n");
    parts[0] = this.pendingLine + parts[0];

    for (const line of parts.slice(0, -1)) {
      this.pushLine(trimTrailingCarriageReturn(line));
    }

    this.pendingLine = parts.at(-1) ?? "";
  }

  private pushLine(line: string): void {
    this.outputLines += 1;

    if (this.firstLines.length < previewEdgeLines) {
      this.firstLines.push(line);
    }

    this.lastLines.push(line);
    if (this.lastLines.length > previewEdgeLines) {
      this.lastLines.shift();
    }

    if (this.fullPreviewLines !== undefined) {
      this.fullPreviewLines.push(line);
      if (this.fullPreviewLines.length > maxPreviewLines) {
        this.fullPreviewLines = undefined;
      }
    }
  }

  private previewLines(): string[] {
    const lines =
      this.fullPreviewLines === undefined
        ? [...this.firstLines, ...this.lastLines]
        : [...this.fullPreviewLines];

    if (this.pendingLine !== "") {
      lines.push(this.pendingLine);
    }

    return lines;
  }

  private lastPreviewLines(): string[] {
    const lines = [...this.lastLines];

    if (this.pendingLine !== "") {
      lines.push(this.pendingLine);
    }

    return lines.slice(-previewEdgeLines);
  }
}

function trimTrailingCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
