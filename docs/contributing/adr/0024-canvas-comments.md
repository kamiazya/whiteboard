# ADR-0024: Canvas comments — a first-class annotation layer

**Status:** Accepted

## Context

The MCP Apps widget shipped an append-only "sticky note" (a plain text node
added through `wb_canvas_edit`), and user feedback immediately redrew the
target: what is wanted is a **comment** — point at a place on a view-only
canvas, say something about it, and have that feedback reach the AI (or,
later, another person) as a signal to act. Three properties follow that no
existing mechanism has together:

1. **Anchored, not placed.** A comment is ABOUT a spot or an object. It
   carries an anchor point (and optionally a target node), while where its
   bubble draws is a rendering decision — floating near the anchor, never
   participating in content layout, never moved by `tidy`, never part of
   what the document says.
2. **Concurrent-safe.** The feature exists for collaboration — human⇄AI
   today, human⇄human later — so two peers commenting at the same time must
   both survive a CRDT merge.
3. **Cross-surface.** Comments must be visible wherever the canvas renders:
   the MCP Apps widget, `wb_scene_render`/PNG export, the viewer, and the
   apps/web editor. Per ADR-0013 decision 8, that means SVG scene rendering,
   not an HTML overlay.

Each existing home fails at least one of these, measured against the real
code rather than assumed:

- **A facet payload** (ADR-0013) merges replace-whole-payload — two peers
  appending to a `comment.threads` facet concurrently lose one side's
  comment. Facets model attributes; comments accumulate.
- **The canvas-level `x-whiteboard` envelope value** is stored whole-value
  LWW in the Loro bridge (`canvas` map) — same concurrent loss.
- **A text node with comment styling** pollutes content: it would be
  exported as content, rearranged by `tidy`, counted by every consumer, and
  its "floating" requirement contradicts a node's fixed geometry.
- **An editor-side HTML overlay** vanishes from every non-editor surface
  (the ADR-0013 argument, verified against `layoutSpatialCanvas`).

## Decision

### 1. A comment is a first-class object of the spatial document

`canvasCommentSchema` (model):

```
{ id, x, y, text, author?, createdAt?, targetNodeId?, resolved? }
```

- `x`/`y` is the ANCHOR (JSON Canvas integer coordinates): the point the
  comment is about. No width/height — a comment has no box of its own.
- `targetNodeId` narrows the anchor to "about this node"; renderers follow
  the node's current position and fall back to the anchor point. A dangling
  target is VALID — a comment may outlive its subject, and the annotation
  layer must never make the document unreadable. Deleting a node does NOT
  cascade to its comments.
- `author` is an OKF actor string (`human:<id>` / `process:<id>`, ADR-0016),
  so the `human:` prefix keeps its trust meaning; `createdAt` is an OKF
  timestamp. Both optional — identity is a keeper concern deferred with the
  multi-user work.
- `resolved` is the lifecycle: a resolved comment stays in the document (it
  is the record of the conversation) and default rendering hides it.

### 2. File format: under the canvas-level `x-whiteboard`, dropped by strict mode

In the model type and the serialized JSON Canvas file, comments live at
`x-whiteboard.comments`. This amends the canvas-level extension rule a
second time (the first was ADR-0013's `facets` bucket): the rule's spirit —
a consumer that drops the key still holds the complete document — HOLDS for
comments, because what is lost is the conversation about the content, not
the content. `x-whiteboard` stays the only non-standard key ever emitted;
strict-mode export drops comments with the rest of the extension; the
published `x-whiteboard.schema.json` carries the shape.

### 3. Storage: one Loro map keyed per comment

The bridge stores comments in a dedicated `comments` map, one entry per
comment id — the same granularity as nodes and edges, and the reason
decision 2's file placement does not decide the merge story.
`writeSpatialCanvas` splits `comments` out of the envelope value on write;
`readSpatialCanvas` reassembles, dropping a corrupt entry per comment
rather than failing the layer. `writeCanvasComment` /
`deleteCanvasComment` are the fine-grained paths (resolve = rewrite with
`resolved: true`). The map joins `CONTENT_CONTAINER_KEYS` so tree-hosted
documents pre-attach it (the undo/redo invariant). Measured cost: +31B per
document at create time in the workspace-record scoreboard, and the
shallow-snapshot reclaim is no longer byte-identical to create time (9B
leaner at 10 documents) — both pinned where they are measured.

### 4. Rendering: pins composed into the SVG scene, above content

canvas-render composes comment markers AFTER nodes and edges in
`layoutSpatialCanvas`'s emission, from existing scene-node kinds, so pins
paint above content and appear in every surface that renders the scene.
Comments are core model data — this is direct composition, not a plugin
`RenderContribution`. Floating placement (near the anchor or the target
node's current box, avoiding content where cheap) is owned by the renderer;
resolved comments are not drawn.

### 5. Delivery to the AI is a surface concern, not stored state

The widget submits a comment through `wb_canvas_edit` AND, where the host
supports it (`getHostCapabilities()?.message`), injects a user-role message
via ext-apps `sendMessage` so the model responds to the feedback
immediately. Hosts without the capability degrade to the document write
alone — the comment still reaches the AI on its next read. Nothing about
delivery is persisted; the document records the comment, not the
notification.

### 6. The sticky note is renamed, not kept beside this

The widget's sticky-note affordance becomes comment creation (visually
distinct pin, click-to-anchor). No compatibility surface: 0.0.x, no users
(vocabulary.md's standing policy).

## This increment

Decisions 1-3 (model schema + published JSON schema, bridge storage with
the concurrent-merge tests, the scoreboard re-measurement). Rendering
(decision 4), the `wb_canvas_edit` comment ops, and the widget surface
(decisions 5-6) land as their own increments; the apps/web editor's
interactive comment UI follows after those.

## Consequences

- Comments merge per comment: concurrent human⇄AI or human⇄human
  commenting cannot lose a side. Concurrent edits to the SAME comment are
  whole-comment LWW, which is right for text nobody co-edits.
- Every surface that renders the scene shows comments with zero extra
  wiring, because they travel inside `SpatialCanvas` (`canvas_view`
  already ships the whole canvas to the widget).
- A strict JSON Canvas export loses the conversation. Accepted: strict
  mode is interop with consumers that could not draw it anyway.
- The envelope-purity rule (comments never stored inside the `canvas`
  map's extension value) is load-bearing and pinned by a bridge test; a
  writer that bypasses the bridge reopens the concurrent-loss bug.
- Threads (replies), mentions, and per-user read state are all future
  value-space extensions of the comment object, not new mechanisms.

## Alternatives considered

- **A `comment` plugin facet** — replace-whole-payload merge loses
  concurrent comments; rejected on the CRDT ground above, not on taste.
- **Comment as a styled text node** — pollutes content, export, and tidy;
  contradicts floating placement.
- **Editor-only HTML overlay** — invisible to the widget, exports, and the
  viewer, which are the surfaces the feature was asked for.
- **A separate comments document/store beside the canvas** — a second
  thing to sync, version, and promote; the CRDT document already provides
  exactly the merge and transport comments need.
- **Top-level `comments` key in the file** — breaks the published
  "`x-whiteboard` is the only non-standard key" contract for no modelling
  gain.
