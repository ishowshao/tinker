import { mkdir } from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  buildBoundedOutputPreview,
  MAX_PREVIEW_LINES,
  PREVIEW_EDGE_LINES,
  type OutputPreviewSource,
} from "./bounded-output-preview";

export type TaskOutputSnapshot = {
  outputBytes: number;
  outputLines: number;
  preview: string;
  truncated: boolean;
  omittedLines?: number;
};

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
    const source: OutputPreviewSource =
      this.fullPreviewLines === undefined
        ? {
            outputLines,
            firstLines: this.firstLines,
            lastLines: this.lastPreviewLines(),
          }
        : {
            outputLines,
            lines: this.previewLines(),
          };
    const bounded = buildBoundedOutputPreview(source);

    return {
      outputBytes: this.outputBytes,
      outputLines,
      ...bounded,
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

    if (this.firstLines.length < PREVIEW_EDGE_LINES) {
      this.firstLines.push(line);
    }

    this.lastLines.push(line);
    if (this.lastLines.length > PREVIEW_EDGE_LINES) {
      this.lastLines.shift();
    }

    if (this.fullPreviewLines !== undefined) {
      this.fullPreviewLines.push(line);
      if (this.fullPreviewLines.length > MAX_PREVIEW_LINES) {
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

    return lines.slice(-PREVIEW_EDGE_LINES);
  }
}

function trimTrailingCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
