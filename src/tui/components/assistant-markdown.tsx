import { createContext, memo, useContext, type ReactNode } from "react";
import { MarkdownText, type RenderOptions } from "@assistant-ui/react-ink-markdown";
import {
  getPreparedShikiHighlighter,
  type TuiShikiHighlighter,
} from "../shiki-highlighter";

export type AssistantMarkdownProps = {
  text: string;
};

const tableOptions = {
  tableTruncate: false,
} satisfies Pick<RenderOptions, "tableTruncate">;

const HighlighterContext = createContext<TuiShikiHighlighter | undefined>(undefined);

// The runner resolves Shiki initialization before mounting App, so immutable
// messages can safely move into Ink Static on their first rendered frame.
export function AssistantMarkdownProvider(props: { children: ReactNode }) {
  const highlighter = getPreparedShikiHighlighter();
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
