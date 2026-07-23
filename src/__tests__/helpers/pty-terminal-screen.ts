import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/headless";

export class PtyTerminalScreen {
  private readonly terminal: Terminal;
  private readonly unicodeAddon: Unicode11Addon;
  private pendingWrite = Promise.resolve();
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

  write(data: string | Uint8Array): Promise<void> {
    const write = this.pendingWrite.then(
      () =>
        new Promise<void>((resolve) => {
          this.terminal.write(data, resolve);
        }),
    );
    this.pendingWrite = write;
    return write;
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
    this.unicodeAddon.dispose();
    this.terminal.dispose();
  }
}
