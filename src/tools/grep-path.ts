// Quote only paths that need escaping; ordinary paths remain easy to scan/copy.
export function formatGrepPath(filePath: string): string {
  return /[\p{Cc}\p{Cf}"\\\u2028\u2029]/u.test(filePath)
    ? JSON.stringify(filePath).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (character) =>
        character
          .split("")
          .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
          .join(""),
      )
    : filePath;
}
