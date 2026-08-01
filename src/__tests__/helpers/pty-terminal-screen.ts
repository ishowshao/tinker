import { HeadlessTerminalScreen } from "../../tools/terminal-screen";

export class PtyTerminalScreen {
  private readonly screen: HeadlessTerminalScreen;

  constructor(rows: number, columns: number) {
    this.screen = new HeadlessTerminalScreen(rows, columns);
  }

  get rows(): number {
    return this.screen.rows;
  }

  get columns(): number {
    return this.screen.columns;
  }

  get bracketedPasteMode(): boolean {
    return this.screen.bracketedPasteMode;
  }

  write(data: string | Uint8Array): Promise<void> {
    return this.screen.write(
      typeof data === "string" ? new TextEncoder().encode(data) : data,
    );
  }

  async resize(rows: number, columns: number): Promise<void> {
    await this.screen.resize(rows, columns);
  }

  async flush(): Promise<void> {
    await this.screen.flush();
  }

  text(): string {
    return this.screen.text();
  }

  dispose(): void {
    this.screen.dispose();
  }
}
