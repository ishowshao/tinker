const successPreviewLines = 5;
const failurePreviewLines = 15;

export type BashDisplayDetail = {
  command: string;
  outputPreview?: string[];
  omittedOutputLines?: number;
  outputFilePath?: string;
};

export function bashCommandFromArgs(args: unknown): string | undefined {
  return nonEmptyString(asRecord(args).command);
}

export function bashResultDetail(raw: unknown): BashDisplayDetail | undefined {
  const rawRecord = asRecord(raw);
  const command = nonEmptyString(rawRecord.command);

  if (command === undefined) {
    return undefined;
  }

  const preview = typeof rawRecord.preview === "string" ? rawRecord.preview : "";
  const previewLines = preview === "" ? [] : preview.split("\n");
  const maxLines = rawRecord.ok === true ? successPreviewLines : failurePreviewLines;
  const outputPreview = previewLines.slice(-maxLines).map(sanitizeOutputLine);
  const totalLines =
    typeof rawRecord.outputLines === "number"
      ? rawRecord.outputLines
      : previewLines.length;
  const omittedOutputLines = Math.max(0, totalLines - outputPreview.length);

  return {
    command,
    outputPreview,
    omittedOutputLines,
    outputFilePath: nonEmptyString(rawRecord.outputFilePath),
  };
}

// Terminal output routinely carries ANSI escapes and control characters that
// would corrupt the Ink layout, so both patterns intentionally match them.
/* eslint-disable no-control-regex */
const ansiEscapePattern = new RegExp(
  "\\u001b(?:\\[[0-9;?]*[@-~]|\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)?|[@-Z\\\\-_])",
  "g",
);
const controlCharPattern = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f]", "g");
/* eslint-enable no-control-regex */

export function sanitizeOutputLine(line: string): string {
  return line
    .replace(ansiEscapePattern, "")
    .replace(controlCharPattern, "")
    .replaceAll("\t", "  ");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
