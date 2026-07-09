# WebSearch Tool Design

## Goal

Give the agent a web search tool backed by the paid Exa `/search` API, with a
tool surface that matches Claude Code's `WebSearch` tool so the model can rely
on a familiar, well-proven contract.

## Tool Contract (aligned with Claude Code)

- Name: `WebSearch`
- Parameters:
  - `query` (string, required, min length 2): the search query.
  - `allowed_domains` (string[], optional): only include results from these
    domains. Mapped to Exa `includeDomains`.
  - `blocked_domains` (string[], optional): never include results from these
    domains. Mapped to Exa `excludeDomains`.

## Exa Request

`POST https://api.exa.ai/search` with header `x-api-key: $EXA_API_KEY` and body:

```json
{
  "query": "...",
  "type": "auto",
  "numResults": 10,
  "contents": { "highlights": true },
  "includeDomains": ["..."],
  "excludeDomains": ["..."]
}
```

- `type: "auto"` balances relevance and latency (~1s) per Exa's guidance.
- `contents.highlights` returns query-relevant excerpts with predictable token
  cost; full `text` is intentionally not requested.
- The HTTP call uses `fetch` directly (no `exa-js` dependency) with a 30s
  `AbortSignal.timeout`.
- Canonical API reference:
  https://exa.ai/docs/reference/search-api-guide-for-coding-agents

## Result and Observation

`WebSearchRawResult` keeps `query`, `searchType`, `requestId`, mapped
`results[]` (`title`, `url`, `publishedDate`, `author`, `highlights`),
`resultCount`, `costDollars`, and `durationMs`. The observation renders a
numbered list of results with URL, publish date, and highlights collapsed to
single lines. Errors (validation, HTTP status, network, malformed body) are
returned as `ok: false` with a message close to the source.

## Registration

`createDefaultTooling` registers `WebSearch` only when an Exa API key is
available (`webSearchApiKey` option, falling back to `EXA_API_KEY` in the
environment, which Bun loads from `.env`). Without a key the model never sees
the tool, so it cannot call something that would always fail.
