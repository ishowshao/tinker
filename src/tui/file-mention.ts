import type { LineEditorState } from "./line-editor";

export const MAX_FILE_MENTION_RESULTS = 8;

export type FileMention = {
  start: number;
  end: number;
  query: string;
};

export type FileMentionMatch = {
  path: string;
  indices: readonly number[];
  score: number;
};

export function findFileMention(editor: LineEditorState): FileMention | undefined {
  const chars = [...editor.value];
  let anchor: number;

  if (editor.cursor < chars.length && !isWhitespace(chars[editor.cursor])) {
    anchor = editor.cursor;
  } else if (editor.cursor > 0 && !isWhitespace(chars[editor.cursor - 1])) {
    anchor = editor.cursor - 1;
  } else {
    return undefined;
  }

  let start = anchor;
  while (start > 0 && !isWhitespace(chars[start - 1])) {
    start -= 1;
  }

  if (chars[start] !== "@") {
    return undefined;
  }

  let end = anchor + 1;
  while (end < chars.length && !isWhitespace(chars[end])) {
    end += 1;
  }

  return {
    start,
    end,
    query: chars.slice(start + 1, end).join(""),
  };
}

export function replaceFileMention(
  editor: LineEditorState,
  mention: FileMention,
  filePath: string,
): LineEditorState {
  const chars = [...editor.value];
  const replacement = [...filePath];
  const suffix = chars.slice(mention.end);
  const reusesSeparator = isHorizontalWhitespace(suffix[0]);
  const separator = reusesSeparator ? [] : [" "];

  return {
    value: [
      ...chars.slice(0, mention.start),
      ...replacement,
      ...separator,
      ...suffix,
    ].join(""),
    cursor: mention.start + replacement.length + 1,
  };
}

export function rankWorkspaceFiles(
  files: readonly string[],
  query: string,
  limit = MAX_FILE_MENTION_RESULTS,
): FileMentionMatch[] {
  if (query === "") {
    return files
      .map((filePath) => ({ path: filePath, indices: [], score: 0 }))
      .sort((left, right) => compareShallowPaths(left.path, right.path))
      .slice(0, limit);
  }

  return files
    .map((filePath) => fuzzyMatchPath(filePath, query))
    .filter((match): match is FileMentionMatch => match !== undefined)
    .sort(compareFileMatches)
    .slice(0, limit);
}

function fuzzyMatchPath(filePath: string, query: string): FileMentionMatch | undefined {
  const pathChars = [...filePath];
  const queryChars = [...query];
  const fullPathMatch = fuzzySubsequence(pathChars, queryChars, 0);
  const basenameStart = findBasenameStart(pathChars);
  const basenameMatch = fuzzySubsequence(
    pathChars.slice(basenameStart),
    queryChars,
    basenameStart,
  );

  if (basenameMatch !== undefined) {
    return {
      path: filePath,
      indices: basenameMatch.indices,
      score: basenameMatch.score + 200,
    };
  }

  if (fullPathMatch === undefined) {
    return undefined;
  }

  return {
    path: filePath,
    indices: fullPathMatch.indices,
    score: fullPathMatch.score,
  };
}

function fuzzySubsequence(
  candidate: readonly string[],
  query: readonly string[],
  indexOffset: number,
): { indices: number[]; score: number } | undefined {
  const indices: number[] = [];
  let candidateIndex = 0;
  let previousIndex = -1;
  let score = 0;

  for (const queryChar of query) {
    const normalizedQueryChar = queryChar.toLowerCase();
    let matchIndex = -1;

    while (candidateIndex < candidate.length) {
      if (candidate[candidateIndex]?.toLowerCase() === normalizedQueryChar) {
        matchIndex = candidateIndex;
        break;
      }
      candidateIndex += 1;
    }

    if (matchIndex === -1) {
      return undefined;
    }

    score += 100;
    if (previousIndex >= 0) {
      const gap = matchIndex - previousIndex - 1;
      score += gap === 0 ? 40 : -gap;
    }
    if (isBoundary(candidate, matchIndex)) {
      score += 30;
    }

    indices.push(matchIndex + indexOffset);
    previousIndex = matchIndex;
    candidateIndex = matchIndex + 1;
  }

  score -= candidate.length - query.length;
  return { indices, score };
}

function compareFileMatches(left: FileMentionMatch, right: FileMentionMatch): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }

  const depthDifference = pathDepth(left.path) - pathDepth(right.path);
  if (depthDifference !== 0) {
    return depthDifference;
  }

  const lengthDifference = [...left.path].length - [...right.path].length;
  return lengthDifference === 0
    ? comparePathText(left.path, right.path)
    : lengthDifference;
}

function compareShallowPaths(left: string, right: string): number {
  const depthDifference = pathDepth(left) - pathDepth(right);
  return depthDifference === 0 ? comparePathText(left, right) : depthDifference;
}

function comparePathText(left: string, right: string): number {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();

  if (normalizedLeft < normalizedRight) {
    return -1;
  }
  if (normalizedLeft > normalizedRight) {
    return 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathDepth(filePath: string): number {
  return [...filePath].filter((char) => char === "/" || char === "\\").length;
}

function findBasenameStart(chars: readonly string[]): number {
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    if (chars[index] === "/" || chars[index] === "\\") {
      return index + 1;
    }
  }
  return 0;
}

function isBoundary(chars: readonly string[], index: number): boolean {
  if (index === 0) {
    return true;
  }

  const previous = chars[index - 1];
  return (
    previous === "/" ||
    previous === "\\" ||
    previous === "." ||
    previous === "_" ||
    previous === "-" ||
    isWhitespace(previous)
  );
}

function isHorizontalWhitespace(char: string | undefined): boolean {
  return char !== undefined && char !== "\n" && char !== "\r" && isWhitespace(char);
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/u.test(char);
}
