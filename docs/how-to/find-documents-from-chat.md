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

## Also search by meaning (optional)

By default search matches WORDS. It will not find a document that says the
same thing in different words, or in a different language — ask for
「通信が切れたときの復旧」 and a note titled *Reconnect runbook* stays
hidden, because the two share no text.

Turning on semantic search adds that. A local embedding model runs beside
the daemon and its ranking is fused with the word-based one, so everything
that already matched still matches; meaning-based results are added rather
than substituted.

It is off by default because the model is a ~113MB download. Two deliberate
steps turn it on:

```bash
# once — downloads the model into your data directory
pnpm --filter @kamiazya/whiteboard-mcp search:fetch-model

# then start the daemon with
WHITEBOARD_SEMANTIC_SEARCH=1
```

After that everything is local and offline: nothing is sent anywhere, and
the model is never re-fetched. The daemon never downloads on its own — if
the model is missing, search quietly stays word-based rather than blocking
on a download.

Measured on the project's judged corpus, with the model on: queries that
word-based search could not answer at all (a paraphrase, or a Japanese
question about an English document) are all answered, and every query that
already worked is unchanged. See
[ADR-0015](../contributing/adr/0015-search-quality-scoreboard.md) for the
numbers.
