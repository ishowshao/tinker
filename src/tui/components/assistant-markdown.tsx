import {
  MarkdownText,
  type RenderOptions,
  useShikiHighlighter,
} from "@assistant-ui/react-ink-markdown";

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

const tableOptions = {
  tableTruncate: false,
} satisfies Pick<RenderOptions, "tableTruncate">;

export function AssistantMarkdown(props: AssistantMarkdownProps) {
  const highlighter = useShikiHighlighter({
    theme: "github-dark",
    langs: highlightedLanguages,
  });

  return (
    <MarkdownText
      {...tableOptions}
      text={props.text}
      highlighter={highlighter}
      codeBox
      codeWrap
      tableBorder="unicode"
    />
  );
}
