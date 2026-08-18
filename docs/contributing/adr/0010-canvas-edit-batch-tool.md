# ADR-0010: One batch tool for spatial editing, and why it is not `apply`

**Status:** Accepted

## Context

[ADR-0009](0009-mcp-tool-naming.md) settled what MCP tools are *called*. It did
not question how many there should be, and the spatial surface grew one tool per
verb: `wb_node_add`, `wb_node_patch`, `wb_edge_add`, `wb_edge_patch`,
`wb_node_lock`, `wb_edge_lock`, `wb_canvas_tidy`.

Each is defensible on its own. Together they made the common case expensive:

- **A ten-node diagram cost twenty-odd round trips**, each a separate document
  load and save, with the model tracking ids across all of them.
- **Every node required four invented integers.** `sharedNodeFieldsSchema` makes
  `x`, `y`, `width` and `height` required, which is correct for JSON Canvas 1.0
  storage and wrong to demand of a model that is trying to think about a
  diagram. A layout engine already existed (`wb_canvas_tidy`); nothing told the
  model to place roughly and then tidy.
- **Nothing could be deleted.** There was no delete tool at all. The only way to
  remove a node was `wb_document_set`, a whole-document replace. The
  `drawing-visuals` skill taught agents to work around this by patching an
  unwanted node "into something harmless".
- **Results carried no new information.** `wb_node_add` echoed back the node it
  was handed, so a model that lost track of the board had to spend another call
  reading it — and the read it would reach for, `wb_scene_digest`, reports
  geometry only and carries no text at all.

Playwright MCP is the obvious reference point, and it is worth being precise
about what it actually does, because it is easy to borrow the wrong lesson. It
has **no batch mechanism** and 40+ imperative single-action tools. What makes it
work is that its snapshot is *addressable* — actions reference refs the snapshot
minted — and that action results carry fresh page state. Batching is not
Playwright's answer to anything; a human clicks one button at a time. A diagram
is not built one node at a time, so batching is this domain's own need.

## Decision

**One tool, `wb_canvas_edit`, is the entire spatial-mutation surface.** It takes
an ordered op list — `node.add`, `node.patch`, `node.remove`, `edge.add`,
`edge.patch`, `edge.remove`, `node.lock`, `edge.lock`, `tidy` — and applies it as
a single transaction: one load, one save, every op or none. A refusal names the
failing op by index, in the message as well as on the error class, because only
`.message` survives the MCP error path.

The seven tools above are **retired**, not deprecated. No aliases.

Three properties follow from the shape rather than being bolted on:

1. **Geometry is optional on the tool's input.** The stored model schema is
   untouched — JSON Canvas 1.0 still requires integers. A node with no geometry
   is placed in a fixed grid below the existing content and the position chosen
   is reported under `geometry`, alongside anything `tidy` moved.
2. **The result carries the resulting board** under `snapshot`, so no second read
   is needed. It reuses `wb_canvas_snapshot`'s projection rather than a parallel
   one, so the two cannot disagree.
3. **`node.remove` / `edge.remove` are new capability.** Removing a node takes
   its edges with it, because a dangling edge stores a canvas that
   `spatialCanvasSchema` refuses on the next read.

**A companion read, `wb_canvas_snapshot`, answers "what is on the board":** each
node's type, text, geometry and lock state, plus every edge, with a per-node text
budget and per-list caps that report the board's *real* totals alongside. It does
not replace `wb_scene_digest`, which answers "is the board tidy" and carries no
text. Neither subsumes the other.

**The retirement is backed by tests, not by an argument.** Of the 44 cases across
the seven retired test files, 11 asserted behaviour `wb_canvas_edit`'s own tests
did not reach — a locked *node* not freezing the edges touching it, an edge lock
not leaking onto a node sharing its id, tidy's scope/fixpoint/lock-avoidance, the
kind-undefined write declaring `spatial`. Those were ported and green *before*
the tools were deleted.

That ordering is the decision, not an implementation detail. The `annotate` tool
was removed the same way once and nothing replaced it; `canvas-viewer`'s
sticky-note control still sits unmounted because every submission failed at the
host with an unknown-tool error while the control looked live.

## Consequences

- The spatial-mutation surface is 1 tool instead of 7. The whole registered
  surface goes from 21 tools to 17 (7 retired, 3 added).
- A diagram is one call. Failure is atomic and legible by op index.
- A model no longer invents coordinates unless the layout carries meaning.
- Pruning is possible, so guidance that taught agents to repurpose unwanted
  nodes is gone from `drawing-visuals`.
- `wb_canvas_edit` is registered under the per-document write lock: it reads the
  whole canvas, decides ids and placements against what it read, and writes it
  back. Two unserialized batches would mint the same id and lose an update.
- **ADR-0009 is not rewritten.** It named these seven tools and that record
  stands; a decision record is history. This ADR is where the retirement lives.
- `BANNED_PATTERNS` in `skills-tool-surface.test.ts` now carries the seven names,
  beside `Excalidraw` and `/api/debug`, so prose teaching the old
  one-call-per-edit shape fails loudly rather than quietly going stale.
- **`viewport` joins ADR-0009's entity list.** `wb_viewport_set` points a
  watching browser at part of a canvas — the `viewport_request` WebSocket
  message has existed since the HTTP viewport route was added, and until now
  nothing exposed it to an agent while `routes/viewport.ts`'s own no-client
  hint told callers to "run viewport_set", a tool that did not exist. A
  viewport is not a document-model noun like the rest of that list: it
  belongs to a client, not to stored content. It stays inside the `wb_`
  plane anyway, because that plane is "an agent asking the daemon to do
  something", which this is. ADR-0009 point 7's exemption is narrower than
  it looks — it covers tools the MCP Apps HOST renders (`canvas_view`,
  `canvas_open`), not everything that touches a UI.
- **`ServerDeps` grows an optional `clientNotifier`.** It is optional so that
  every existing composition, and every test, remains a valid server without
  one; a tool that needed a browser to be present would stop being headless.
  `wb_canvas_edit` announces what it touched and follows it with a viewport
  fit (opt out with `follow: false`); `wb_viewport_set` answers
  `delivered: false` rather than failing when nobody is watching.
- **`agent_activity` is one message, not a begin/end pair.** A batch is
  atomic and lands in milliseconds, so a paired form would only flicker, and
  an `end` lost to a dropped socket would strand the indicator on forever.
  Presence is the client's job: hold "an agent is editing" for a few seconds
  after the last message and let it lapse. This is also why `wb_node_lock`
  could not have been reused for presence — a lock is durable sidecar state,
  so an agent that crashes leaves one behind for a human to clear.

## Alternatives considered

**Declarative desired state** (`wb_canvas_set { nodes, edges }`, server diffs
against the current board). The most natural thing to hand a model: "here is the
diagram I want." Rejected because it is destructive under concurrent editing —
anything a human added that the agent's payload does not mention reads as
"should be deleted". This is a shared whiteboard; that failure mode is the
product's whole point of difference.

**Intent-level layout delegation** (`wb_diagram_author { layout, nodes, edges }`,
server positions everything). Strongest for authoring a diagram from scratch, and
its core benefit — not making the model invent coordinates — was absorbed into
optional geometry instead. Rejected as the primary shape because it cannot
express a partial edit to an existing board, so a second tool would have been
needed anyway.

**Region-scoped declarative op** (`{ op: "region.set", within, nodes, edges }` —
"this group should look like this"). Not rejected, deferred: it is the only op
that deletes what it was not told about, and the boundary question (what if a
human is mid-drag across the group edge?) deserves its own increment.

**Keeping `wb_canvas_tidy` as a standalone tool.** It is the most likely one-shot
call and the only pre-existing declarative-ish tool. Retired anyway: a special
case erodes the "one entry point" property that makes the surface easy to choose
from, and tidy-after-edit — the common case — is one op in a batch that was
happening regardless.

**Naming it `wb_canvas_apply`.** It shipped under that name and was renamed before
review. `apply` is the verb of declarative reconcilers (kubectl, Terraform),
where you hand over the desired state and the server computes the diff — exactly
the alternative rejected above. A name that promises semantics the tool does not
have is worse than a bland one.

**Naming it `wb_canvas_view` / `wb_canvas_draw`.** `canvas_view` already exists as
the MCP Apps widget tool that ADR-0009 point 7 deliberately keeps outside the
`wb_` data plane; two tools differing only by a `wb_` prefix and doing different
jobs is a tool-selection trap no description can fix. `draw` under-describes:
an agent wanting to delete a node would not look for it.
