# Wire Protocol

This repo uses two main transport surfaces:

- MCP over `stdio` or Streamable HTTP
- Browser synchronization over Server-Sent Events (SSE), with ordinary `POST`s upstream

## MCP surface

- `stdio` is the packaged distribution default.
- `/mcp` is the preferred local-development path.
- `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, and `prompts/get` are exposed through the MCP SDK.

## Browser synchronization

[ADR-0050](../adr/0050-local-daemon-trust.md) retired the persistent socket the
first daemon used; the SSE stream below is the only live transport a page has,
whether it reaches a local daemon through the browser extension or a
server-mode keeper directly. The contract is declared once, in
`packages/daemon-client/src/sync-sse-contract.ts`, and both ends import it.

One stream serves many documents: browsers cap concurrent HTTP/1.1 connections
per origin, and a stream per open canvas would starve the daemon's own API. The
page keeps a single stream and adjusts what it follows over `POST`, because SSE
itself is one-way.

| Endpoint | Direction | Purpose |
|---|---|---|
| `GET /api/sync/stream` | daemon to browser | The event stream. The daemon mints the stream id and announces it as the first event; holding it is what proves the stream is yours. |
| `POST /api/sync/subscribe` | browser to daemon | Follow or stop following documents (`subscribe` / `unsubscribe`, at most 256 per stream). Answers the documents the stream now follows. |
| `POST /api/sync/message` | browser to daemon | One client message for one document, addressed by the stream id. |

A document is addressed by its doc key, `${workspaceId}/${path}`, or by
`workspace:${workspaceId}` for the workspace record as a whole. A request that
names a stream the daemon does not hold answers `404 unknown_stream`.

### Events on the stream

| Event | Payload | Meaning |
|---|---|---|
| `ready` | `{ streamId }` | The first event. |
| `update` | `{ doc, update }` | A Loro update for a workspace record, base64-encoded because SSE frames are text. Only incremental updates travel here; the initial snapshot is served as binary by the document's `snapshot` route, so the largest payload never pays the base64 inflation. |
| `message` | `{ doc, raw }` | A text frame (below) addressed to one document. `raw` is the frame's JSON, validated by the receiver against `serverTextMessageSchema`. |

### Text frames

The frames are declared in `packages/daemon-client/src/sync-frames.ts`; the
stream carries them inside `message` events.

Server to client:

- `version_created`: a version was saved; carries the version entry.
- `restore_started`: a restore began; may carry a label.
- `restore_complete`: the restore finished.
- `viewport_request`: an agent asked the page to move its viewport; carries the
  request id and what to frame, or where to pan and zoom. It is withheld from a page until that
  page has sent `client_ready` for the document, and replayed once it has.
- `agent_activity`: what an agent just did to this document, once per applied
  edit batch, for a human watching. It is never replayed.

Client to server, through `POST /api/sync/message`:

- `client_ready`: the page has the document and can apply a viewport. It is the
  only client message today.

## Payload shape

- JSON is used for events, frames and request bodies.
- Loro update bytes travel base64-encoded inside an `update` event.
- Message handling is document-scoped by doc key.

## Version skew: strict requests, tolerant responses

The hosted app updates itself behind a service worker; the daemon is installed
separately. The two are routinely different versions, so the contracts the
browser and the daemon share follow one rule:

- **A schema the daemon parses a request with is `.strict()`.** The daemon decides
  what it accepts, and refusing an undeclared field tells a caller its value did
  not take effect. The `subscribe` and `message` request bodies above are examples.
- **A schema the browser parses a response with is not.** A newer daemon adding a
  field is a compatible change; a strict reader would report a move that landed
  as failed, or refuse to unlock a replica. Zod's default object strips the
  unknown field, which is what a reader wants. This covers refusal bodies, the
  parts of a response, and the SSE events and text frames above, which are
  deliberately not strict for the same reason: a field added to a frame must not
  make every older client drop it.
- **A daemon that wants to refuse an undeclared field it EMITS** applies
  `.strict()` at the emit site (`routes/replica-key.ts` does), where no browser
  sees it. The error body is the same split: `apiErrorBodySchema` is the strict
  contract a daemon emits, and `apiErrorReason` reads through a tolerant one.
- **A tool output is strict and the answer derived from it is not.** The MCP SDK
  checks what a tool handler returned against its `outputSchema`, so those stay
  `.strict()`. The `/api/v1` answers the browser parses are derived from them in
  `api-contracts/v1-answers.ts` by `tolerantAnswer`, which makes every object
  at any depth strip an unknown key. Aliasing the tool output instead would make
  a newer daemon's added field fail a document create that had succeeded.

### A new enum member is the same skew as a new field

A stripped key costs nothing, but an enum a newer daemon gave a new member fails
the parse around it — and what is around it is often a whole listing, search or
history. The policy is by what the value is FOR:

- **A value that is only displayed degrades per value, and the answer around it
  stays readable.** An optional enum (a document `kind`, a workspace `tier`, a
  purge's `skippedReason`) reads an unknown member as absent — `unknownIsAbsent`,
  which `tolerantAnswer` also applies to every optional enum in the answers it
  derives. A required one with a neutral member reads as that member through
  `.catch`: an operator `kind` as `system`, a compaction `reason` as `no-gain`.
  Both keep the inferred type, so the daemon still types what it emits from the
  same schema, and a request is parsed with the strict original.
- **A value a decision is made on stays lockstep**, and a new member is a
  breaking change that waits for the browser to update: replica tier on the
  replica-key answer (custody and lease), a workspace role, the storage report's
  categories (exhaustive on purpose), the model's colour presets. Refusal
  codes are read with `safeParse` beside `apiErrorReason`, so a code a build
  cannot name still shows the daemon's own sentence rather than failing.

`answers-tolerant.test.ts` walks every enum a browser-parsed answer still reads
strictly and requires each to be listed with its reason (`LOCKSTEP`), from both
sides: an enum that is not listed fails, and a listed one no answer reaches any
more fails too. The list is keyed by an enum's members, so a degraded and a
strict use of the same members share an entry; the per-site cases beside it
parse an unknown member through each degraded schema to hold the other half.

The split is made by declaration name — `*RequestSchema` may be strict, nothing
else in `api-contracts/` may. Two guards hold it: `tools/arch-lint`'s
`api-contract-response-tolerance.test.ts` reads the declarations (and the
barrel's re-exports), and daemon-client's `answers-tolerant.test.ts` walks the
live schema graph of everything the package publishes and fails on any strict
object that is not a request (and, above, on an unlisted strict enum). What no
test yet covers is a recorded response from an older and a newer daemon parsed
by the other side's schemas.

## Why this matters

- `update` is how whiteboard state reaches a page; the SSE stream is what keeps
  every open tab and the agent looking at the same document.
- `restore_started` / `restore_complete` let the browser coordinate long-running restore flows without stale UI.
- `client_ready` is what stops an agent's viewport request being applied before a page can honour it.

For MCP debugging steps, use [mcp-debugging](../mcp-debugging.md).
