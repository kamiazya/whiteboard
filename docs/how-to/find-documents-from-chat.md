# Find documents from chat

Ask your agent to find documents by what they contain — the
`wb_document_search` MCP tool searches full text, not just titles.

What it covers:

- markdown bodies
- canvas text: text nodes, group labels, and **edge labels** (a diagram's
  meaning lives in its relations, so they are searchable content)
- document names and paths

Japanese (and other CJK) queries work without any dictionary or download,
down to a single character — 「た」 finds 「たささたはな」, so a query answers
while it is still being typed. Results come back ranked, with a context excerpt around each match, and can
be narrowed by `kind` (markdown / spatial) or by tags.

Example prompts:

> 「検索基盤について書いた文書を探して」
> "Find the canvas where something depends on redis"

The same search is available to tools over
`GET /api/v1/workspaces/:id/search?q=…`. The query string reads four keys:

| key | meaning |
|---|---|
| `q` | the words to match, at most 1,024 characters |
| `kind` | `markdown` or `spatial`, to narrow by kind |
| `tag` | a tag the document carries; repeat it (`tag=a&tag=b`) to require several, at most 1,024 |
| `limit` | at most this many results (1–50, default 10) |

A search needs `q`, a `tag` or a `kind` (a filter answers alone). Any other
key is refused with `400 invalid_request` naming it, rather than ignored —
`tags=x` would otherwise answer every document as though the filter had
applied.

The query is bounded because every word in it is looked up across every
document the workspace holds: `wb_document_search` and the route refuse a
longer `q` with "a search query is longer than the 1024-character limit", and
more than 1,024 tags with the tag-count limit. The web app's search box stops
taking characters at the same limit. A query is a few words; a longer text is a
document to compare against, not something to search for.

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
# once — install the CLI and the embedding runtime side by side
npm install -g @kamiazya/whiteboard-mcp @huggingface/transformers

# once — download the model into your data directory (add --full for the
# higher-precision weights)
whiteboard search fetch-model --json
```

Then set `WHITEBOARD_SEMANTIC_SEARCH=1` in **every process that answers a
search**, because each one decides for itself whether to use the model:

- the daemon: `WHITEBOARD_SEMANTIC_SEARCH=1 whiteboard daemon run`;
- the MCP server your agent starts, which is what answers
  `wb_document_search` in a chat. Put the variable in that server's `env`
  block in your MCP client's configuration, and start it from the global
  install (`"command": "whiteboard", "args": ["mcp"]`) rather than through
  `npx`, which would not see the runtime.

**Install the runtime where `whiteboard` can find it.** The server loads
`@huggingface/transformers` by resolving it from its own package's directory,
so the runtime has to sit in the same `node_modules` tree as
`@kamiazya/whiteboard-mcp` — as the global install above puts them. A copy in
your project's directory, or `npx` unpacking the package somewhere else, is
invisible to it and `search fetch-model` answers `runtime-missing`.

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

With `--json` it prints one object with `"schemaVersion": 1` and a `kind` of
`ok` or `failed`; a failure carries `failure` (the names above, plus
`load-failed` and `unexpected-dimensions`), `remedy`, and, when there is
something more to say, a redacted `detail`.

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
