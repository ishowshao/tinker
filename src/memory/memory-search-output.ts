import type { MemoryTextSearchResult } from "../tools/types";

export function renderMemoryTextSearch(result: MemoryTextSearchResult): string {
  const sections = result.files.map(({ filePath, lines }) => {
    const path = /[\p{Cc}\p{Cf}"\\\u2028\u2029]/u.test(filePath)
      ? JSON.stringify(filePath)
      : filePath;
    const output = [`File: ${path}`, ""];
    let previous: number | undefined;
    for (const line of lines) {
      if (previous !== undefined && line.lineNumber > previous + 1)
        output.push("", "…", "");
      output.push(`${line.match ? ">" : " "} ${line.lineNumber} | ${line.text}`);
      previous = line.lineNumber;
    }
    return output.join("\n");
  });
  if (sections.length === 0) sections.push("No matches found on this page.");
  if (result.hasMore)
    sections.push(`More results available; nextOffset=${result.nextOffset}.`);
  else sections.push("End of results.");
  return sections.join("\n\n");
}
