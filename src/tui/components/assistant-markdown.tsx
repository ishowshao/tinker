import { MarkdownText, useShikiHighlighter } from "@assistant-ui/react-ink-markdown";

export type AssistantMarkdownProps = {
  text: string;
};

const highlightedLanguages = [
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
];

export function AssistantMarkdown(props: AssistantMarkdownProps) {
  const highlighter = useShikiHighlighter({
    theme: "github-dark",
    langs: highlightedLanguages,
  });

  return (
    <MarkdownText
      text={props.text}
      highlighter={highlighter}
      codeBox
      codeWrap
      tableBorder="unicode"
    />
  );
}
