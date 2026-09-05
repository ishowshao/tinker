export const MAX_CLI_DIAGNOSTIC_DETAIL_BYTES = 512;

const TRUNCATION_MARKER = "...[truncated]";
const ESCAPE = String.fromCharCode(27);
const ANSI_CSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, "g");

export type CliCommandScope = "root" | "run" | "update" | "serve" | "connect";

export interface CliOutputWriter {
  write(chunk: string): boolean | void;
  readonly writableNeedDrain?: boolean;
  once?(event: "drain", listener: () => void): unknown;
}

export class CliUsageError extends Error {
  constructor(
    message: string,
    readonly scope: CliCommandScope,
  ) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function renderUsageError(error: CliUsageError): string {
  const hint =
    error.scope === "root"
      ? 'Run "tinker --help" for usage.'
      : `Run "tinker ${error.scope} --help" for usage.`;
  return `error: ${sanitizeDiagnosticDetail(error.message)}\n${hint}\n`;
}

export function renderCliFailure(label: string, error: unknown): string {
  return `${label}: ${sanitizeDiagnosticDetail(errorMessage(error))}\n`;
}

export function sanitizeDiagnosticDetail(detail: string): string {
  const withoutAnsi = detail.replaceAll(ANSI_CSI_PATTERN, "");
  let escaped = "";
  for (const character of withoutAnsi) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (character === "\n") {
      escaped += "\\n";
    } else if (character === "\r") {
      escaped += "\\r";
    } else if (character === "\t") {
      escaped += "\\t";
    } else if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      escaped += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else {
      escaped += character;
    }
  }
  return truncateUtf8(escaped, MAX_CLI_DIAGNOSTIC_DETAIL_BYTES);
}

export function formatDiagnosticPath(filePath: string): string {
  return sanitizeDiagnosticDetail(JSON.stringify(filePath));
}

export async function writeCliOutput(
  writer: CliOutputWriter,
  output: string,
): Promise<void> {
  if (output === "") {
    return;
  }
  const accepted = writer.write(output);
  if (accepted === false) {
    await waitForDrain(writer);
  }
}

export async function flushCliOutput(writer: CliOutputWriter): Promise<void> {
  if (writer.writableNeedDrain === true) {
    await waitForDrain(writer);
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) {
    return value;
  }

  const contentLimit = maxBytes - Buffer.byteLength(TRUNCATION_MARKER);
  let result = "";
  let byteLength = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (byteLength + characterBytes > contentLimit) {
      break;
    }
    result += character;
    byteLength += characterBytes;
  }
  return result + TRUNCATION_MARKER;
}

function waitForDrain(writer: CliOutputWriter): Promise<void> {
  if (writer.once === undefined) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    writer.once?.("drain", resolve);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
