import type { BundledLanguage, BundledTheme } from "shiki";

export type TuiShikiHighlighter = (code: string, language?: string) => string;

type ShikiToken = {
  readonly content: string;
  readonly color?: string;
};

export type TuiShikiTokenizer = {
  codeToTokensBase(
    code: string,
    options: { readonly lang: string; readonly theme: string },
  ): readonly (readonly ShikiToken[])[];
};

const THEME = "github-dark";
const HIGHLIGHTED_LANGUAGES = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "json",
  "bash",
  "shellscript",
  "python",
  "markdown",
  "html",
  "css",
  "yaml",
  "diff",
] as const;

let preparation: Promise<void> | undefined;
let highlighter: TuiShikiHighlighter | undefined;

export function prepareShikiHighlighter(): Promise<void> {
  preparation ??= createTuiShikiHighlighter(async () => {
    const { createHighlighter } = await import("shiki");
    const tokenizer = await createHighlighter({
      themes: [THEME],
      langs: [...HIGHLIGHTED_LANGUAGES],
    });
    return {
      codeToTokensBase: (code, options) =>
        tokenizer.codeToTokensBase(code, {
          lang: options.lang as BundledLanguage,
          theme: options.theme as BundledTheme,
        }),
    };
  }).then((prepared) => {
    highlighter = prepared;
  });
  return preparation;
}

export function getPreparedShikiHighlighter(): TuiShikiHighlighter | undefined {
  return highlighter;
}

export async function createTuiShikiHighlighter(
  createTokenizer: () => Promise<TuiShikiTokenizer>,
): Promise<TuiShikiHighlighter | undefined> {
  try {
    const tokenizer = await createTokenizer();
    return (code, language) => {
      if (language === undefined || language === "") {
        return code;
      }
      try {
        return tokenizer
          .codeToTokensBase(code, { lang: language, theme: THEME })
          .map((line) =>
            line
              .map((token) => {
                const ansi = tokenColorToAnsi(token.color);
                return ansi === undefined
                  ? token.content
                  : `${ansi}${token.content}\u001b[39m`;
              })
              .join(""),
          )
          .join("\n");
      } catch {
        return code;
      }
    };
  } catch {
    return undefined;
  }
}

function tokenColorToAnsi(color: string | undefined): string | undefined {
  if (color === undefined || !color.startsWith("#") || color.length < 7) {
    return undefined;
  }
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  if ([red, green, blue].some((component) => Number.isNaN(component))) {
    return undefined;
  }
  return `\u001b[38;2;${red};${green};${blue}m`;
}
