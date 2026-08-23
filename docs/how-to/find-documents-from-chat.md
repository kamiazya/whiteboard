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
the daemon, and the two rankings are FUSED: a document both halves like
rises above one that only one half likes. Word matching is not replaced,
but it is no longer the only voice — on a large workspace a weak keyword
match can be ranked below a strong match by meaning, and fall off the end
of the results you asked for.

It is off by default because it is not small: the embedding runtime is
~384MB installed, and the model itself is a further ~118MB download (~470MB
at full precision — see below). Neither arrives unless you ask for it. Three
deliberate steps turn it on:

```bash
# once — install the embedding runtime beside the server
npm install @huggingface/transformers

# once — download the model into your data directory (add --full for the
# higher-precision weights)
whiteboard search fetch-model --json

# then start the daemon with
WHITEBOARD_SEMANTIC_SEARCH=1
```

**You choose how good a job it does.** The same model ships in two
precisions, and the download and the quality are the same dial:

| | download | measured quality |
|---|---|---|
| `WHITEBOARD_SEMANTIC_SEARCH=1` | ~118MB | the default |
| `WHITEBOARD_SEMANTIC_SEARCH=full` | ~470MB | 0.051 nDCG@10 higher |

That 0.051 is about 11% better ranking, measured on a public Japanese
retrieval benchmark rather than asserted. Add `--full` to the fetch command
if you want that side of it — fetch the precision you intend to run, since
the daemon never downloads on its own.

`whiteboard search fetch-model` verifies by USE rather than by looking for
files: it reports success only once an embedding actually comes back at the
width the search index is built for. If a step is missing it says which one
— `runtime-missing` means the first command, `weights-missing` means the
second.

Working from a clone of the repository instead? `pnpm --filter
@kamiazya/whiteboard-mcp search:fetch-model` runs the same command against
your checkout.

After that everything is local and offline: nothing is sent anywhere, and
the model is never re-fetched. The daemon never downloads on its own — if
the model is missing, search stays word-based rather than blocking on a
download, and says so in its log with the step that would fix it.

Measured on the project's judged corpus, with the model on: queries that
word-based search could not answer at all (a paraphrase, or a Japanese
question about an English document) are all answered, and every query that
already worked is unchanged. See
[ADR-0015](../contributing/adr/0015-search-quality-scoreboard.md) for the
numbers.
