# ADR-0026: The annotation layer — one plane per document, threads, and selector anchors

**Status:** Proposed — design of record for generalising comments beyond the canvas

## Context

[ADR-0024](0024-canvas-comments.md) gave the spatial canvas a comment layer and
[ADR-0025](0025-comment-editor-ux.md) gave it editor UX. Both were written for
**one format and one message**: a comment carries `x`/`y` and an optional
`targetNodeId`, it holds a single `text`, and `resolved` sits on it.

Three requirements arrived together (user, 2026-09-02):

1. Show and hide resolved comments **at the document level**, not from a
   corner of the canvas's context menu.
2. Markdown documents need comments too, **stored the same way** as the
   canvas's — deliberately, with a third and fourth format in mind.
3. A comment starts a **conversation**; replies belong in the data shape.

And a constraint on how to answer them: decide it **now**, from what the shape
should be rather than from what it is, and decide it **with the UI**, because
every increment of comment UI built on the current shape adds to the migration.

### What is already true, measured before designing

The size of this job is not what the file format suggests, and the difference
is worth stating first because it changes which decisions are expensive.

- **A comment is already stored one level above content.** `loro-bridge.ts`
  keeps `comments` as a document-level Loro map — a peer of `nodes`, `edges`
  and `body` in `CONTENT_CONTAINER_KEYS`, never nested inside the canvas
  envelope. ADR-0024 decision 3 put it there for per-comment concurrent merge,
  and that placement is already the plane this ADR argues for.
- **What is canvas-only is the schema, the file projection, and the readers.**
  `canvasCommentSchema` requires spatial `x`/`y`; `canvasExtensionSchema`
  projects the layer into the file under the canvas-level `x-whiteboard`; and
  `readSpatialCanvas` is the only reader, so a markdown document's `comments`
  map is *unreachable* rather than absent.
- **The spatial anchor is already resolved as an ordered pair of selectors.**
  `commentAnchor()` answers the target node's corner while that node exists and
  the stored point otherwise. That is exactly the resolution order this ADR
  generalises — the mechanism exists, unnamed.

So the question is not where to move comments to. It is what shape they should
have had, now that a second format and a conversation exist.

## Decision

### 1. The annotation layer is a plane of its own, per document — not content, and not a facet

A document has **content** (what it says) and an **annotation layer** (what
people and agents say *about* it). They are siblings under the document, not
parent and child. Comments are never exported, never tidied, never part of what
the document means — ADR-0024 stated those as rules; this makes them properties
of where the data lives, which is the only way a rule like that survives.

**Not a facet**, and the reasons are worth writing down because the question is
a fair one:

- A facet is a *single* namespaced, versioned, schema'd attribute group per key
  ([ADR-0013](0013-facet-system.md)), written whole. An annotation layer is an
  unbounded, growing collection whose items have their own identity and must
  merge **per item** — writing it as one value is precisely the concurrent-loss
  failure ADR-0024's per-comment map exists to prevent, and would lose a reply
  written at the same moment as another.
- Facets on an OKF document project into **frontmatter**, i.e. into the
  exported file. Comments must not be there.
- A facet describes *what an object is*. A comment is not a property of the
  document; it is a separate object that points at it.

**Not a separate document** either: it would need its own identity, its own row
in the index, its own trash and version semantics, and every read of a document
would become two. The plane rides the document it annotates.

### 2. A thread is the anchored unit; comments are the messages inside it

```
Thread   { id, anchor, status: 'open' | 'resolved', createdAt, messages }
Message  { id, body, author?, createdAt, editedAt? }
```

The anchor and the status belong to the **thread**, not to any one message:

- A conversation is what gets resolved. With `resolved` on a comment and
  replies beside it, "which one's flag counts?" has no defensible answer.
- A reply has no anchor of its own; it inherits the thread's.
- One pin per thread falls out. With a self-referential `parentId` the
  renderer would have to derive "which comments are roots" before it could
  draw anything.

Today's flat comment is exactly **a thread with one message**, which is what
makes the migration mechanical rather than interpretive.

Messages are keyed by id in a nested map (so two peers replying concurrently
write different keys and both survive) and **ordered by `createdAt`, id as the
tiebreak** — deterministic without a list container, matching how this
codebase orders everything else it must reproduce.

### 3. The anchor is the only format-varying part, and it is a set of selectors rather than a position

```
anchor = { kind: 'spatial', … } | { kind: 'text', … }        // one arm per format
```

Every arm has the same two-part structure, which the spatial one already has:
**an optional reference to an object, and a positional fallback**, tried in
order. A reference is stable while the thing exists and gone when it does not;
a position always resolves and is sometimes wrong. Keeping both, and saying
which is tried first, is the whole of robust anchoring.

- `spatial`: `{ nodeId?, x, y }` — today's shape, unchanged in behaviour.
- `text`: a **quote** (`prefix` / `exact` / `suffix`) plus a character
  `position`, and — if the spike below confirms it — a CRDT-stable cursor
  ahead of both.

The quote is not belt-and-braces: an offset is invalidated by any edit earlier
in the body, by an export and re-import, and by an agent rewriting the body
wholesale through `wb_document_set`. A quote survives all three, and is the
selector the [W3C Web Annotation Data
Model](https://www.w3.org/TR/annotation-model/) (`TextQuoteSelector` +
`TextPositionSelector`) exists to standardise. We are not adopting the
vocabulary wholesale — only the idea it settled, that a target is a *list of
ways to find the place*.

**A spike decides the first selector, not an argument.** Loro exposes stable
cursor positions that survive concurrent edits; whether this version's JS
binding exposes them, and whether one serialises into a stored anchor, was not
verifiable from this repo's installed typings and must be measured before the
text arm is written. The design holds without it (quote + position is what
Hypothesis and Google Docs ship); it is materially better with it, because a
cursor is exact under merge where a quote is a search.

**The union stays closed.** Every format is in this repo, and a closed union
buys the exhaustiveness checking the renderers rely on — the same decision
`canvas-render` made for its scene-node union. A plugin-registered anchor kind
is deferred until a format ships from outside.

### 4. An anchor that cannot be resolved is orphaned, never dropped

Deleting the subject of a conversation must not delete the conversation. A
thread whose anchor no longer resolves becomes **orphaned**: still listed,
still readable, still resolvable, no longer drawn in place. This is not an edge
case to handle later — it is the ordinary consequence of editing a document
that has been commented on, and it is the requirement that decides the UI
below, because there is nowhere on a canvas or in a text column to draw
something that has no place.

### 5. The document-level surface is a comments panel with a filter, shared by both editors

This supersedes **ADR-0025 decision 2** ("a show/hide toggle, not a panel"), on
that decision's own stated trigger — *"a persistent Comments panel is the named
upgrade if dogfooding shows the toggle insufficient"*. Three things make it
insufficient now, and none of them is a matter of taste:

- The toggle lives on the canvas's empty-space context menu. A markdown
  document has no such surface, so the same feature cannot exist twice.
- An orphaned thread has no place to be drawn, and therefore no place to be
  reached.
- "Show resolved" on a dense canvas answers *whether* resolved comments are
  drawn. What a reader wants at document level is *which conversations are
  open*, which is a list.

So: **one panel component, two hosts.** It lists threads (anchor excerpt,
status, message count, last message), filters on Open / Resolved / All, and
jumps to the anchor. Each editor keeps its own in-place projection — the canvas
its pins and bubbles, markdown an inline highlight plus a gutter marker — and
the panel is the document-level control the user asked for.

The filter stays **per-user view state, never written to the shared document**
(ADR-0025 decision 2's other half, which survives intact): one person's filter
must not change what another sees.

### 6. The MCP surface becomes document-scoped

`wb_canvas_edit`'s `comment.*` ops are canvas-scoped, so an agent cannot
comment on a markdown document at all. The ops move to a document-scoped
surface (`thread.add` / `message.add` / `thread.resolve`), which is also what
makes the "no removal on either side" symmetry of ADR-0025 hold for a format
that has no canvas. Published surface, so it is its own increment with its own
smoke step.

Authorship stays as ADR-0025 decision 3 left it — the editor writes no
`author`, MCP clients write OKF actor strings — with one consequence now worth
naming: in a **thread**, an unlabelled human message beside a labelled AI one
is how the panel tells the two participants apart. That is enough for the
human⇄AI case this ships for, and it is not enough for human⇄human, which is
already gated on real identity.

### 7. Order of work: data, readers, UI, MCP

1. **Model + storage.** `threadSchema` / `messageSchema` / `anchorSchema` in
   `model`; `threads` container in `loro-adapter` with per-message merge; a
   one-pass migration turning each stored comment into a one-message thread.
   Property test first: two peers replying concurrently to the same thread both
   survive, which is the invariant the whole shape exists for.
2. **Readers.** `readSpatialCanvas` stops projecting comments; a
   format-agnostic `readAnnotations(doc)` serves both editors. This is where
   the file projection question (below) is settled.
3. **UI.** The panel, then markdown's in-place projection, then the canvas's
   existing pins re-pointed at threads.
4. **MCP.** Document-scoped ops + smoke.

Landing them in that order is what keeps the migration to one step: every
increment after step 1 is written against the shape it will keep.

## Consequences

- The comment-UX work already in flight (create, edit, move, resolve, reopen,
  the resolved toggle) survives as **thread-level verbs**; what changes under
  it is the schema and the reader, not the gestures. Nothing in that work is
  wasted, and it is the reason step 1 should not wait long — each further UI
  increment on the old shape is another call site to move.
- `sceneDigest` already excludes comment chrome (ADR-0025 decision 5), so the
  AI-facing digest needs no change from this.
- A document's annotation layer becomes something the workspace can count and
  index — "3 open conversations" is a document-list fact, cheaply, once threads
  have a status. Not in scope here; noted because the shape allows it and the
  old one did not.
- Two documents' worth of comments can no longer be confused: the plane is
  keyed by document, and a format that gains comments gains them by having a
  reader, not by having a schema field.

## Open questions for the human gate

- **Does an exported file carry its conversations?** Today's canvas file does,
  under `x-whiteboard.comments`, which contradicts ADR-0024's own "never
  exported" and means a strict-mode export silently drops them. The choices are
  (a) the layer is keeper-side only — a file is content, and exporting then
  re-importing loses the conversation; or (b) an explicit sidecar projection so
  a file can travel with its annotations when the user asks for that. This
  changes what step 2 writes.
- **Sequencing against the stack in flight.** Land the seven-PR comment-UX
  stack first (it is green, its verbs survive), or hold it and put the data
  layer underneath it first?

## Alternatives considered

- **A facet on the document** — rejected in decision 1: wholesale writes lose
  concurrent replies, and facets are exported.
- **`parentId` on a flat comment list** — rejected in decision 2: it puts
  resolution and anchoring on an arbitrary member of the conversation, and
  makes "what do I draw a pin for" a derivation.
- **A separate annotations document per document** — rejected in decision 1:
  doubles identity, indexing, trash and version semantics for no gain the plane
  does not already give.
- **Character offsets alone for the text anchor** — rejected in decision 3: an
  edit anywhere earlier in the body silently moves every comment below it, and
  the failure is invisible (the comment still points at *something*).
- **Deleting a thread whose anchor is gone** — rejected in decision 4: it makes
  editing a document destroy feedback about it, which is the one thing an
  annotation layer must not do.
