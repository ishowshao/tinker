import path from "node:path";

export const MAX_SOURCE_LINES = 2000;

export function countSourceLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split(/\r\n|\n|\r/);
  return lines.length - (lines.at(-1) === "" ? 1 : 0);
}

export async function findSourceLineViolations(
  sourceRoot: string,
): Promise<Array<{ file: string; lines: number }>> {
  const violations: Array<{ file: string; lines: number }> = [];
  for await (const file of new Bun.Glob("**/*").scan({
    cwd: sourceRoot,
    onlyFiles: true,
    dot: true,
  })) {
    const lines = countSourceLines(await Bun.file(path.join(sourceRoot, file)).text());
    if (lines > MAX_SOURCE_LINES) violations.push({ file, lines });
  }
  return violations.sort((left, right) => left.file.localeCompare(right.file));
}

if (import.meta.main) {
  const violations = await findSourceLineViolations(
    path.resolve(import.meta.dir, "../src"),
  );
  if (violations.length > 0) {
    for (const { file, lines } of violations) {
      console.error(
        `src/${file}: ${lines} lines exceeds the ${MAX_SOURCE_LINES}-line limit.`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(
      `Source line limit passed: every file under src/ is <= ${MAX_SOURCE_LINES} lines.`,
    );
  }
}
