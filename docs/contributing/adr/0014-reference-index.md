# ADR-0014: Cross-document references are a derived projection with an event-fed aggregate

**Status:** Accepted

## Context

The Connections surface (backlinks on the document page) needs an answer to
"who links to this document" across documents. Each document is its own Loro
CRDT; the naming table (path, display name) lives outside the CRDTs in the
DocumentIndex. A reference is therefore a fact that spans two authorities:
one document's *content* and the workspace's *naming table* — and its truth
can change when **neither endpoint** changed (a third document taking an
already-used name breaks that name's resolution for everyone).

Two pressures shape the design: the document boundary must stay sound under
CRDT merges, and the mechanism must have a scaling path that does not
require redesign (an incremental, event-fed index) while starting simple.

## Decision

### 1. References are derived facts, never content

Nothing about references is written into any LoroDoc. A cross-document edge
stored as CRDT content would need merge semantics of its own; a projection
needs none and is rebuildable from the store at any time. Consistency with
what a reader sees is the correctness bar: **a `[[Name]]` the reader leaves
as literal text is never a backlink** — one shared scanner
(`codec/references/scan.ts`) and one shared resolution rule
(`codec/references/unique-name-resolver.ts`, aliases are paths *and*
display names, ambiguity resolves to nothing) enforce this on both sides.

### 2. Extraction and resolution split at the CRDT boundary

- **Extraction** (`server-core/references/extract.ts`) is per-document and
  pure over a persisted snapshot: markdown wikilinks, spatial embed nodes,
  file-node path refs, text-node wikilinks. It runs only at the persistence
  boundary — CRDT concurrency is resolved inside Loro before extraction
  sees anything, so no mid-merge state is ever observed.
- **Resolution** happens at query time against the current naming table.
  Extracted facts cache well (they depend on one document alone); their
  resolution deliberately does not (it depends on the whole table).

### 3. One aggregate, two feeding modes

`ReferenceAggregate` (server-core) holds per-document facts keyed by a
caller-supplied `seq`: stale events are ignored, duplicates are no-ops,
removes are tombstones. `computeBacklinks` runs it in *non-incremental*
mode — build from a full scan per request, query, discard. The incremental
mode (save paths emitting upsert/remove events into one long-lived
instance) reuses the same class, so the two modes cannot drift. Switching
is a wiring change gated on measurement, not a redesign.

### 4. Command-based PBT pins the semantics structurally

Two property suites in `server-core/src/references/` are the enforcement:

- `reference-semantics.property.test.ts` — model-based: random command
  sequences (create / write body / canvas edit / rename path / set name /
  delete) run against the real pipeline and an independent naive model,
  which must agree after every command. Its generator is deliberately
  skewed toward alias collisions; the last-wins resolver mutation survived
  a uniform generator and is what the skew exists to catch.
- `reference-aggregate.property.test.ts` — convergence: shuffled +
  duplicated event delivery equals in-order delivery; tombstones resist
  stale resurrections. This suite immediately caught output ordering
  depending on event arrival order, which is why `backlinksOf` sorts by
  the DocumentIndex contract's segment-wise path order.

## Consequences

- Backlinks are always consistent with reader resolution, including the
  third-document rename case, at the cost of query-time resolution work.
- The O(N)-scan route is correct by construction (no event plumbing to
  miss) and carries a `ponytail:` marker naming the upgrade path.
- Wiring the incremental feed later must hook **every** mutation path
  (tools, WS sync, imports); the convergence properties give that wiring
  its safety net in advance.

## Alternatives considered

- **Resolve at extraction time** (store resolved edges): rejected — a
  rename or name collision elsewhere silently invalidates stored edges,
  and the invalidation set is unbounded.
- **Store edges in a CRDT** (a links document): rejected — invents merge
  semantics for derived data and makes the index a second source of truth.
- **Incremental index first**: rejected for now — every mutation path is a
  place to miss an event; the scan cannot be stale. The aggregate class is
  shared so the switch stays cheap.
