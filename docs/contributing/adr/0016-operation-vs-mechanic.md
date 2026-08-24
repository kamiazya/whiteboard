# ADR-0016: An operation is a use case; the composition root holds only mechanics

**Status:** Proposed

## Context

Four defects found in one session share a single cause, and each looked like
its own bug until the fourth one made the pattern visible:

- `wb_document_delete` removed the index row and the stored bytes and stopped;
  the HTTP `DELETE` additionally unlinked the `.loro` blob, its
  `.pre-migrate-bak`, one thumbnail per version, and evicted the doc cache. A
  document an agent deleted was not deleted the way one a human deleted was.
  Both surfaces answered `{ deleted: true }` throughout (#1035).
- The HTTP write path scheduled a debounced op-log compaction through a
  saved-listener. The agent write path reached `documentStore.saveSnapshot`
  directly and told nobody, so an agent-driven canvas never compacted. In
  stdio MCP it was worse: `installAutoCompact` is called from HTTP route
  registration, so tracing the static import graph from the stdio entry
  reaches 76 modules and `store/auto-compact.ts` is not among them — no
  emitter *and* no subscriber (#1046).
- `@huggingface/transformers` was declared by no package, so semantic search
  resolved in the repo, in CI, and in no install anywhere (#1035).
- `/api/v1` is mounted only when a composition root passes `serverDeps`, and
  only one of the two does — so an entire route surface exists in one
  deployment shape and not the other, with no rationale recorded either way.

### What is actually misplaced, measured rather than assumed

The obvious reading is "logic has accumulated in the composition root":
`packages/mcp-server` is 32,283 lines against `packages/server-core`'s 5,691,
and `mcp-server/src/server/store` alone is 10,147 — nearly twice the whole
shared layer. Fifty HTTP routes live in `mcp-server`, nine in `server-core`.

That reading is wrong, and the line counts are what make it look right.
Classifying every file in `store/` by what it imports — `node:*`, kysely,
libsql, `fs/promises` on one side; model, ports, codec, loro on the other —
the directory is overwhelmingly real storage mechanics:

```
807  infra=11 domain=4   document-store.ts
489  infra=6  domain=2   version-store.ts
402  infra=5  domain=0   file-gc-sweeper.ts
391  infra=4  domain=0   branches-store.ts
301  infra=2  domain=1   branch-merge.ts
229  infra=4  domain=1   sqlite-document-index.ts
186  infra=2  domain=0   auto-compact.ts
 76  infra=0  domain=1   doc-cache.ts
 51  infra=0  domain=2   count-alive-nodes.ts
```

Only 127 lines import no infrastructure at all. SQLite schema, file blobs,
the doc cache, per-workspace locks and GC sweeps belong in a composition
root and are correctly there.

**The defect is not that logic sits in the wrong package. It is that an
operation and its storage mechanics are the same function.**
`document-store.ts` is `infra=11 domain=4` because it is both at once, so
"delete a document" cannot be invoked without dragging SQLite and the
filesystem along — and a second surface that cannot drag them has no option
but to reimplement the operation. Every defect above is that reimplementation
diverging, or a mechanic reachable from only the surface that happened to
wire it.

## Decision

### 1. Three kinds, and a question that decides between them

| kind | what it is | where it lives |
|---|---|---|
| **Operation** | something a user or an agent asks for — delete a document, save a version, merge a branch | `server-core`, expressed over ports and named seams only |
| **Mechanic** | how *this* deployment stores, caches, locks, schedules or sweeps | the composition root, behind a port or a seam |
| **Adapter** | an HTTP route, an MCP tool registration | the composition root; transport translation, no logic |

The question that decides it: **could a second surface need this?** A second
surface is any other way in — the MCP tool beside the HTTP route, stdio
beside the daemon, a future browser or Workers composition. If yes, it is an
operation. If it is only *how this machine does it*, it is a mechanic.

### 2. A mechanic never contains an operation

This is the invariant the four defects violated, and it is what makes the
rule more than a preference. A composition root may hold as much machinery
as it needs; it may not hold a second answer to "what does deleting a
document mean".

`documentTeardown` (#1035) is the shape: everything about a document that is
neither its index row nor its bytes — thumbnails, blobs, the cached instance
— is named on `ServerDeps`, and `document-store.ts`'s `deleteDocument`
collapsed to path resolution plus the same three shared steps the MCP tool
runs. `documentWritten` (#1046) is the same shape on the write side.

### 3. A seam that is required cannot be forgotten

Both seams are **required** fields on `ServerDeps`, not optional ones.
Optional is what let the original defect exist, and a hand-written "is it
wired?" assertion only ever covers the dependency somebody remembered to
write one for. Verified: removing `documentTeardown` from the container
gives `error TS2741: Property 'documentTeardown' is missing … but required
in type 'ServerDeps'`.

The cost is real and worth stating: every PR that adds a `ServerDeps`
construction site conflicts with an in-flight branch until one of them
lands. Main merged three such PRs in twenty minutes during #1035. The
conclusion is to land a required-field change on its own small PR, not to
make the field optional again.

### 4. Adapters translate; they do not decide

An HTTP route resolves its path parameters, calls the operation, and maps
the result and its errors onto status codes. It does not hold the refusal
rules, the ordering, or the cleanup. Where an adapter and an operation
disagree today, the adapter is what changes.

## Consequences

**Easier.** A new surface gets every operation for free, correctly, because
there is one implementation to call. A capability stops being confined to
the deployment shape that happened to wire it — the auto-compact gap existed
only because a mechanic was installed from HTTP route registration. And the
placement question has one answer, so "where does this go" stops generating
new places.

**Harder.** An operation that genuinely needs a mechanic now has to name a
seam rather than reach for the function, which is more ceremony for the
first caller and is the point. Required seams also make `ServerDeps` a
merge-contended file.

**Not free, and not a big bang.** This ADR describes a target, not a
migration. `store/` is mostly mechanics and mostly stays. What moves is the
entanglement — one operation at a time, each behind ordinary review. A
simultaneous reorganisation is explicitly rejected: main merged roughly
eight PRs in two hours during this session, and a single required-field
change caused three CI failures from merge races alone. A ten-thousand-line
move would be in permanent conflict and would stop delivery, which is the
same reasoning `.claude/rules/vocabulary.md` already applies to renames
("how it converges without anyone scheduling a big-bang rename").

**The rule does not hold by itself.** What diverged, diverged because
nothing prevented it, and prose will not prevent the next one. Two
executable rungs carry it:

- a **parity test** per operation — perform it through each surface against
  the same real data directory and assert the resulting observable state
  (rows, files on disk, cache) is identical. Mechanism-agnostic: it does not
  care whether a seam is a call or an event. When the delete teardown was
  mutated to skip unlinking thumbnails, both the HTTP-path test and the
  agent-path test went red — that is the evidence they share one
  implementation.
- an **arch-lint rule** that an adapter may not import a mechanic directly,
  so a new route cannot quietly grow a second implementation.

The guards land before the moves. A migration with no guard re-admits the
thing it was migrating away from.

## Alternatives considered

**A lifecycle-hook bag, or an event bus, instead of named seams.** Rejected
on this codebase's own evidence. `setDocumentSavedListener` *is* a
single-subscriber event bus, and it is the divergence, not the cure: the
agent path never emitted, and in stdio MCP nothing ever subscribed. Both
failure modes of an event are silent, so it turns one forgettable place into
two. Named, awaited seams also keep three properties the delete teardown
actually needs and events are bad at: ordering (version ids must be captured
before the row cascade), abort (a refused delete must destroy nothing), and
error propagation.

Events remain right for reactions that are genuinely optional,
order-independent and safe to drop — `clientNotifier` is that shape and stays
one.

**A `DocumentService` facade both surfaces call.** The obvious design, and
blocked by a real constraint: such a facade needs the filesystem, the doc
cache and the database, so it can only live in the composition root — and
`server-core`'s tools would then have to call *up* into `mcp-server`,
against the dependency direction `architecture-map.md` enforces. The seam on
`ServerDeps` is the inversion of exactly that call.

**Grouping the seams into one `DocumentLifecycle` object.** Deferred, not
rejected. Two sibling fields do not yet justify the churn of renaming a
required field across every construction site, and the merge-contention cost
above is the reason to wait. Revisit at the third seam. The grouping is
cosmetic either way: what stops a seam rotting is that firing it is
required, not the shape of the interface holding it.

**Reorganising the package boundaries themselves.** Out of scope.
`architecture-map.md` cuts packages by runtime requirement — the shared layer
must run unchanged on Node, the browser and Workers — and nothing found here
argues against that criterion. The defects were inside one composition root,
not across the boundary.
