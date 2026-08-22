# Find documents from chat

Ask your agent to find documents by what they contain — the
`wb_document_search` MCP tool searches full text, not just titles.

What it covers:

- markdown bodies
- canvas text: text nodes, group labels, and **edge labels** (a diagram's
  meaning lives in its relations, so they are searchable content)
- document names and paths

Japanese (and other CJK) queries work without any dictionary or download.
Results come back ranked, with a context excerpt around each match, and can
be narrowed by `kind` (markdown / spatial) or by tags.

Example prompts:

> 「検索基盤について書いた文書を探して」
> "Find the canvas where something depends on redis"

The same search is available to tools over
`GET /api/v1/workspaces/:id/search?q=…`.
