import { lexer, walkTokens, type Token } from "marked";

export type MarkdownSectionFrame = Readonly<{
  markdown: string;
  start: number;
  end: number;
}>;

export type MarkdownSectionFramerResult = Readonly<{
  content: string;
  tail: string;
  sealedEnd: number;
  framingStopped: boolean;
}>;

const ATX_HEADING_LINE = /^ {0,3}#{1,6}(?:[\t ]+|$)/u;

export class MarkdownSectionFramer {
  private source = "";
  private scanOffset = 0;
  private sealedEnd = 0;
  private framingStopped = false;

  push(content: string): readonly MarkdownSectionFrame[] {
    if (content === "") {
      return [];
    }
    this.source += content;
    if (this.framingStopped) {
      return [];
    }

    const frames: MarkdownSectionFrame[] = [];
    while (true) {
      const newline = this.source.indexOf("\n", this.scanOffset);
      if (newline === -1) {
        break;
      }
      const lineStart = this.scanOffset;
      const lineEnd = newline + 1;
      this.scanOffset = lineEnd;
      const line = this.source.slice(lineStart, newline).replace(/\r$/u, "");
      if (!ATX_HEADING_LINE.test(line) || !this.isTopLevelHeading(lineStart, lineEnd)) {
        continue;
      }

      const section = this.source.slice(this.sealedEnd, lineStart);
      if (section.trim() === "") {
        continue;
      }
      if (hasDocumentLevelMarkdownDependency(section)) {
        this.framingStopped = true;
        break;
      }

      frames.push(
        Object.freeze({
          markdown: section,
          start: this.sealedEnd,
          end: lineStart,
        }),
      );
      this.sealedEnd = lineStart;
    }
    return frames;
  }

  finish(): MarkdownSectionFramerResult {
    return Object.freeze({
      content: this.source,
      tail: this.source.slice(this.sealedEnd),
      sealedEnd: this.sealedEnd,
      framingStopped: this.framingStopped,
    });
  }

  reset(): void {
    this.source = "";
    this.scanOffset = 0;
    this.sealedEnd = 0;
    this.framingStopped = false;
  }

  private isTopLevelHeading(lineStart: number, lineEnd: number): boolean {
    const markdown = normalizeMarkedSource(this.source.slice(this.sealedEnd, lineEnd));
    const candidateOffset = normalizeMarkedSource(
      this.source.slice(this.sealedEnd, lineStart),
    ).length;
    let tokenOffset = 0;
    for (const token of lexer(markdown, { gfm: true })) {
      if (tokenOffset === candidateOffset && token.type === "heading") {
        return true;
      }
      tokenOffset += token.raw.length;
    }
    return false;
  }
}

function normalizeMarkedSource(source: string): string {
  return source.replace(/\r\n|\r/gu, "\n");
}

function hasDocumentLevelMarkdownDependency(markdown: string): boolean {
  let found = false;
  void walkTokens(lexer(markdown, { gfm: true }), (token: Token) => {
    if (found) {
      return;
    }
    if (token.type === "def") {
      found = true;
      return;
    }
    if (
      (token.type === "text" || token.type === "link" || token.type === "image") &&
      containsReferenceSyntax(token.raw)
    ) {
      found = true;
    }
  });
  return found;
}

function containsReferenceSyntax(source: string): boolean {
  const bracket = /!?\[(?:\\.|[^\]\\\n])+\](?:[\t ]*\[(?:\\.|[^\]\\\n])*\])?/gu;
  for (const match of source.matchAll(bracket)) {
    const value = match[0];
    const end = (match.index ?? 0) + value.length;
    const hasSecondLabel = /\][\t ]*\[/u.test(value);
    if (hasSecondLabel || !/^[\t ]*\(/u.test(source.slice(end))) {
      return true;
    }
  }
  return false;
}
