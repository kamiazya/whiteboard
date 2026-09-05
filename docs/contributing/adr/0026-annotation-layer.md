# ADR-0026: The annotation layer — one plane per document, threads, and selector anchors

**Status:** Accepted — data layer first (human gate, 2026-09-02); supersedes ADR-0024 decision 2 and ADR-0025 decision 2

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
parent and child.

> **A correction, because this ADR first got it wrong.** An earlier draft of
> this document asserted that ADR-0024 had ruled comments "never exported".
> It did not. ADR-0024 decision 2 deliberately put comments **in** the
> serialized file at `x-whiteboard.comments`, with strict-mode export dropping
> them along with the rest of the extension, and its Consequences accepted the
> loss in as many words: *"A strict JSON Canvas export loses the conversation.
> Accepted: strict mode is interop with consumers that could not draw it
> anyway."* The phrase "never exported" appeared only in `vocabulary.md`'s
> **does-not-mean** column for *Comment* — a compression of ADR-0024's argument
> against modelling a comment as a text NODE (which "would be exported as
> content, rearranged by `tidy`, counted by every consumer"). No human decided
> comments are never exported. This increment removes the phrase from that
> cell, so the compression cannot be cited as a decision again, and decision 1b
> below decides the question now, for reasons that are its own.

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

### 1b. The layer is keeper-side: an exported file carries content, not the conversation

This **supersedes ADR-0024 decision 2**, and the reason is a requirement that
did not exist when that decision was made rather than a principle it missed.

- **A layer that lives in the canvas envelope cannot serve a document that has
  no canvas envelope.** `x-whiteboard.comments` is a key on a JSON Canvas file;
  a markdown document has none. Keeping it there means markdown comments need a
  second home, which is per-format storage — the thing this whole ADR exists to
  avoid. This is the argument that decides it.
- It makes "an annotation is not content" a property of **where the data
  lives** rather than a rule a reader has to remember. ADR-0024 kept the
  separation as a convention and the file shape quietly worked against it.

What this costs, stated rather than glossed:

- **An exported file no longer round-trips its conversation** — in extended
  mode as well as strict. ADR-0024 accepted that loss for strict mode; this
  extends it to both. A user who exports a canvas, re-imports it, and expects
  the comments back will not get them, and there is no UI today that says so.
- **The renderer's input changes.** `layoutSpatialCanvas` reads comments off
  `canvas['x-whiteboard'].comments` today; it will take them as an argument
  beside the canvas instead. One seam, mechanical.
- **`canvas_view`'s payload changes.** The widget gets comments today because
  the tool ships the whole `SpatialCanvas` and they ride inside it. They will
  travel beside it. Published contract, so its own increment.

Portability is not abandoned, only unbundled from the content file: if carrying
annotations with a document is later wanted, it is an explicit export of the
layer, not a key that rides along by default. Nothing here needs that yet, so
nothing here builds it.

### 1c. On ADR-0024's "threads are a value-space extension"

ADR-0024's Consequences read *"Threads (replies), mentions, and per-user read
state are all future value-space extensions of the comment object, not new
mechanisms."* Half of that holds and half does not, and the difference is
decision 2. Replies really are value-space — no new container kind, no new sync
path, no new merge story. But **anchoring and resolution move up a level**,
from the comment to the thread, which is a reshape of the object rather than a
field added to it. ADR-0024 did not consider that, because with one message per
comment the two levels are indistinguishable.

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
increment after step 1 is written against the shape it will keep. The gate
below chose it over landing the UI stack first, so the seven in-flight PRs wait
on step 1 and are moved onto the new shape before they land.

## Consequences

- The comment-UX work already in flight (create, edit, move, resolve, reopen,
  the resolved toggle) survives as **thread-level verbs**; what changes under
  it is the schema and the reader, not the gestures. Nothing in that work is
  wasted — and since the gate chose to land step 1 first, those seven PRs are
  moved onto the new shape before they merge, so no call site is migrated
  twice.
- `sceneDigest` already excludes comment chrome (ADR-0025 decision 5), so the
  AI-facing digest needs no change from this.
- A document's annotation layer becomes something the workspace can count and
  index — "3 open conversations" is a document-list fact, cheaply, once threads
  have a status. Not in scope here; noted because the shape allows it and the
  old one did not.
- Two documents' worth of comments can no longer be confused: the plane is
  keyed by document, and a format that gains comments gains them by having a
  reader, not by having a schema field.

## Settled by the human gate (2026-09-02)

- **Export: keeper-side only** — decision 1b above, with the reasoning made its
  own rather than inherited. Raised because the user did not recognise the
  "never exported" premise as anything they had decided; they were right, and
  the correction is recorded in decision 1 rather than quietly fixed.
- **Sequencing: the data layer goes first, and the comment-UX stack waits for
  it.** The seven PRs are green and stay open; step 1 below lands underneath
  them, then they are moved onto the new shape and land after. This trades a
  few days of the stack sitting for the smallest migration.

## Supplement (2026-09-05): the spike decision 3 asked for, answered

Decision 3 left the first selector to a measurement rather than an argument.
It has been taken, and the answer is **a Loro rich-text mark on the body**,
not the cursor the ADR guessed at.

### What was measured, on loro-crdt 1.13.6

`LoroText.mark(range, key, value)` writes a range that belongs to the
CHARACTERS it covers. Over a body of 20,800 characters carrying 40 marks it:

- follows an insert above the passage, and an insert merged from another
  peer — the case a quote cannot reproduce, because the text no longer says
  where the passage went;
- grows when text is typed strictly inside it, and shrinks to whatever
  survived a partial deletion;
- survives a snapshot and a shallow snapshot, and is visible to a reader
  that never registered any style;
- **disappears when its passage is deleted** — the orphan signal decision 4
  wants and a stored offset can never give;
- reads back in 0.39ms for the whole document, which is why the projection
  reads it rather than caching it.

`getCursor`/`getCursorPos` — the API the ADR had in mind — was measured
first and rejected: a cursor is a POINT, so a range needs two of them, and
each collapses silently when the text around it is deleted. That is exactly
the "always resolves and is sometimes wrong" failure decision 3 rules out.

### The decision, and its cost

**The mark is the live anchor; the quote stays the durable identity.**
Neither replaces the other, and the resolution order is: the mark if the
document has one, then the stored offsets, then the quote's unique
occurrence, then the quote scored against `prefix`/`suffix`, then orphaned.

The cost is a real tension with decision 1, and it is stated rather than
hidden: **decision 1 puts the annotation layer BESIDE content, and a mark
lives INSIDE the body container.** A comment now leaves a trace in the thing
it is about. It is accepted because the trace is one Loro style key on a
range, not content — it serialises to no markdown, so decision 1b's "an
exported file carries content, not the conversation" is unaffected, and a
peer that has never heard of comments reads exactly the body it always did.
The layer is still the source of truth: a mark carries no message, no
status, no id beyond the key, and deleting every mark loses nothing but
precision.

### Three traps, each measured rather than reasoned

1. **A style key containing `:` ABORTS THE WASM** with
   `RuntimeError: unreachable` — not a catchable throw. `annotationIdSchema`
   is `z.string().min(1)`, so an id an MCP peer supplies could otherwise hand
   that peer a remote crash. Keys are percent-encoded (`threadStyleKey`).
2. **`configTextStyle` REPLACES its configuration rather than adding to it.**
   A second call naming only a new key makes marking with the first one throw
   `Style configuration missing`. Every writer must therefore supply the
   complete set every time — a rule a call site can only get wrong — so
   `markThreadPassages` derives it and the raw configurer is module-private.
3. **One shared key carrying the thread id as its VALUE loses an overlap** to
   last-writer-wins: measured, the first thread's range was cut short by the
   second. Each thread gets its own key.

A fourth, which reordered the work: **a wholesale `writeMarkdownBody` deletes
every mark on the document**, because it deleted and re-inserted the whole
text. That is why the minimal-diff splice landed first, as its own increment,
before any of this.

### What does not travel, and what is done about it

Marks do not survive a document leaving the CRDT — a markdown export and
re-import arrives with the conversations intact and no live anchor for any of
them, as does every thread an MCP peer wrote. Both are handled the same way:
**the quote is asked once, at the moment the body is known, and its answer is
written down as a mark.** A thread that already has one is never re-derived
(that would replace the truth with a guess, and undo wherever a merged edit
had carried the passage), and a thread whose quote no longer resolves gets
nothing — marking the nearest thing would make an orphan look placed forever
after, which is what decision 4 forbids.

`unmark` is deliberately not wired. Resolving a thread keeps its anchor, and
this product has no delete for a conversation (ADR-0025 decision: Resolve is
the only way to close one), so there is no caller.

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
- **Keeping comments in the exported file** (ADR-0024 decision 2, extended
  mode) — rejected in decision 1b, on one argument and not on principle: the
  key belongs to a JSON Canvas file and a markdown document has none, so
  keeping it forces a second home for markdown comments. Its real merit — an
  exported canvas that round-trips its conversation — is what decision 1b gives
  up, and says so.
- **A sidecar file beside the export** (`.comments.json`) — not rejected,
  deferred: it keeps portability without putting the layer back inside the
  content, and it needs a write path, a read path and a UI that nothing today
  asks for.
