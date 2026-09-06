import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";

export const TERMINAL_SCREEN_ROWS = 24;
export const TERMINAL_SCREEN_COLUMNS = 80;
export const MIN_TERMINAL_COLUMNS = 2;
export const MAX_TERMINAL_DIMENSION = 1_000;

export type TerminalScreen = {
  readonly rows: number;
  readonly columns: number;
  write(bytes: Uint8Array): Promise<void>;
  flush(): Promise<void>;
  text(): string;
  dispose(): void;
};

export function createTerminalScreen(
  options: { cols?: number; rows?: number } = {},
): TerminalScreen {
  return new HeadlessTerminalScreen(
    options.rows ?? TERMINAL_SCREEN_ROWS,
    options.cols ?? TERMINAL_SCREEN_COLUMNS,
  );
}

export class HeadlessTerminalScreen implements TerminalScreen {
  private readonly terminal: Terminal;
  private readonly unicodeAddon: Unicode11Addon;
  private pendingWrite = Promise.resolve();
  private disposed = false;
  private currentRows: number;
  private currentColumns: number;

  constructor(rows: number, columns: number) {
    this.currentRows = rows;
    this.currentColumns = columns;
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols: columns,
      rows,
      scrollback: 0,
    });
    this.unicodeAddon = new Unicode11Addon();
    this.terminal.loadAddon(this.unicodeAddon);
    this.terminal.unicode.activeVersion = "11";
  }

  get rows(): number {
    return this.currentRows;
  }

  get columns(): number {
    return this.currentColumns;
  }

  get bracketedPasteMode(): boolean {
    return this.terminal.modes.bracketedPasteMode;
  }

  write(bytes: Uint8Array): Promise<void> {
    const copy = new Uint8Array(bytes);
    const pending = this.pendingWrite.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.disposed) {
            reject(new Error("Cannot write to a disposed terminal screen."));
            return;
          }

          try {
            this.terminal.write(copy, resolve);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }),
    );
    this.pendingWrite = pending;
    return pending;
  }

  async resize(rows: number, columns: number): Promise<void> {
    await this.pendingWrite;
    this.terminal.resize(columns, rows);
    this.currentRows = rows;
    this.currentColumns = columns;
  }

  async flush(): Promise<void> {
    await this.pendingWrite;
  }

  text(): string {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < this.rows; row += 1) {
      lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
    }
    while (lines.at(-1) === "") {
      lines.pop();
    }
    return lines.join("\n");
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.unicodeAddon.dispose();
    this.terminal.dispose();
  }
}
