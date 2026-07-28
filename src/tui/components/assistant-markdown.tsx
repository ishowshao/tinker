import { createContext, memo, useContext, type ReactNode } from "react";
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

type SharedHighlighter = ReturnType<typeof useShikiHighlighter>;

const HighlighterContext = createContext<SharedHighlighter>(undefined);

// Mounts the Shiki highlighter once per App instead of once per assistant
// message. Creating a highlighter costs ~64ms per instance, so per-message
// instances dominated frame time in long sessions. While the shared instance
// loads, consumers render plain text and re-render once when it resolves —
// the same fallback timing the per-instance hook already had.
export function AssistantMarkdownProvider(props: { children: ReactNode }) {
  const highlighter = useShikiHighlighter({
    theme: "github-dark",
    langs: highlightedLanguages,
  });
  return (
    <HighlighterContext.Provider value={highlighter}>
      {props.children}
    </HighlighterContext.Provider>
  );
}

// Memoized on `text`: settled assistant messages are immutable, so an
// unchanged text guarantees an unchanged render and the whole markdown
// subtree (including the markdansi re-run inside MarkdownText) can be
// skipped for unrelated frames.
export const AssistantMarkdown = memo(function AssistantMarkdown(
  props: AssistantMarkdownProps,
) {
  const highlighter = useContext(HighlighterContext);

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
});
