export type PageSummaryLimits = {
  maxContentCodePoints: number;
  maxDescriptionCodePoints: number;
  maxHeadingCodePoints: number;
  maxHeadings: number;
};

export type ExtractedPageSummary = {
  url: string;
  title: string;
  description?: string;
  canonicalUrl?: string;
  language?: string;
  headings: Array<{ level: 1 | 2 | 3; text: string }>;
  content: string;
  truncated: boolean;
};

export function extractPageSummaryDocument(
  limits: PageSummaryLimits,
): ExtractedPageSummary {
  const normalizeBlock = (value: string): string => {
    const lines = value
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[\t\f\v ]+/g, " ").trim());
    const normalized: string[] = [];
    let previousBlank = false;
    for (const line of lines) {
      const blank = line === "";
      if (blank && previousBlank) {
        continue;
      }
      normalized.push(line);
      previousBlank = blank;
    }
    return normalized.join("\n").trim();
  };
  const normalizeInline = (value: string): string => value.replace(/\s+/g, " ").trim();
  const truncate = (
    value: string,
    maxCodePoints: number,
  ): { value: string; truncated: boolean } => {
    const codePoints = Array.from(value);
    if (codePoints.length <= maxCodePoints) {
      return { value, truncated: false };
    }
    return {
      value: codePoints.slice(0, maxCodePoints).join(""),
      truncated: true,
    };
  };

  const headingElements = Array.from(document.querySelectorAll("h1, h2, h3"));
  const headings: ExtractedPageSummary["headings"] = [];
  for (const element of headingElements) {
    if (!(element instanceof HTMLElement)) {
      continue;
    }
    const text = truncate(
      normalizeInline(element.innerText),
      limits.maxHeadingCodePoints,
    ).value;
    if (text === "") {
      continue;
    }
    const level = Number(element.tagName.slice(1));
    if (level !== 1 && level !== 2 && level !== 3) {
      continue;
    }
    headings.push({ level, text });
    if (headings.length >= limits.maxHeadings) {
      break;
    }
  }

  const candidates = Array.from(
    document.querySelectorAll("article, main, [role='main']"),
  )
    .filter((element): element is HTMLElement => element instanceof HTMLElement)
    .map((element) => normalizeBlock(element.innerText))
    .filter((text) => Array.from(text).length >= 200)
    .sort((left, right) => Array.from(right).length - Array.from(left).length);
  const bodyText =
    document.body === null ? "" : normalizeBlock(document.body.innerText);
  const rawContent = candidates[0] ?? bodyText;
  const content = truncate(rawContent, limits.maxContentCodePoints);

  const descriptionElement = document.querySelector('meta[name="description" i]');
  const rawDescription =
    descriptionElement instanceof HTMLMetaElement
      ? normalizeInline(descriptionElement.content)
      : "";
  const description = truncate(rawDescription, limits.maxDescriptionCodePoints).value;
  const canonicalElement = document.querySelector('link[rel~="canonical" i]');
  const canonicalUrl =
    canonicalElement instanceof HTMLLinkElement
      ? normalizeInline(canonicalElement.href)
      : "";
  const language = normalizeInline(document.documentElement.lang);

  return {
    url: location.href,
    title: document.title,
    ...(description === "" ? {} : { description }),
    ...(canonicalUrl === "" ? {} : { canonicalUrl }),
    ...(language === "" ? {} : { language }),
    headings,
    content: content.value,
    truncated: content.truncated,
  };
}
