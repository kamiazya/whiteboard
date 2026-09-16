# ADR-0040: Scoped tags are the one classification vocabulary, on documents, boards, nodes and edges

**Status:** Accepted — human gate 2026-09-16 (edges included in the first scope at the owner's request). Supersedes the part of
[ADR-0009](0009-mcp-tool-naming.md) decision 3 that left a spatial document
without `tags`, and [ADR-0036](0036-semantic-axes.md) §6's `semantic.class/v0`,
which retires unshipped. Extends [ADR-0013](0013-facet-system.md) (core
frontmatter stays core; what widens is where it attaches) and gives
[ADR-0033](0033-facet-vocabulary-axis.md) the principled reading of `tags` it
named as an omission. Design of record; nothing implemented.

## Context

The project has two ways to put a label on a thing, and they do not share a
word, a shape or a surface:

| | OKF `tags` | `semantic.class/v0` |
|---|---|---|
| attaches to | markdown documents only | spatial nodes only |
| shape | a flat list of strings | one `{axis, value}` pair per node |
| written by | `wb_facet_set` (`tags.add`/`remove`), the document header | `wb_facet_set` (`facets`), the Facets panel |
| read by | search (`tags` filter), the eval lane | the facet score (a built-in partition) |
| a person says | "tag" | "Axis" and "Value", which a reader could not decode |

Three things made the split worth ending now rather than later.

**A reader could not use the form.** ADR-0036 §6 gave a box's second axis a
registered word and the web editor derived a form for it: a Meaning section
with Axis, Value and Save. The owner looked at it and could not tell what to
enter (2026-09-16). The small fix — examples in the boxes, a datalist of what
the board already uses — landed the same day, and the analysis behind the
next step (`.claude/…` task #96) kept arriving at the same fork: the screen
could say *Category* while the tools say `axis`, or the two could share one
word. The owner rejected the split outright: a person and an agent talk
about the same board, so a word the person uses must be the word the tool
takes. That rules out every "relabel the screen" remedy and leaves only a
vocabulary both sides already know.

**Tags are that vocabulary, and they were floating.** They exist on markdown
documents and nowhere else. A spatial document has none (ADR-0009 decision 3
paid that cost and ADR-0013 left it), a node has none, and the thing a node
CAN carry is the structured facet above. Models write document tags without
being told how — the lane's "tag this note" task passes at pass^3 — while
five rounds of the two-axis task wrote a node facet zero times in fifteen
trials, with the word registered and the write path inline (ADR-0031's
twenty-second reading).

**The structured facet has no data yet.** `semantic.class/v0` is `v0`, landed
on 2026-09-16, and nothing has been stored under it. Retiring it today costs
a revert; retiring it next month costs a migration.

Two constraints from earlier decisions hold and are not reopened:

- ADR-0013 decision 3: no runtime-defined schema. Whatever structure a tag
  carries is either in the model's own grammar or is payload under a
  registered schema.
- OKF's `tags` are free strings by specification. A document written
  elsewhere may carry `Machine Learning` and must survive a read-edit-write
  here unchanged.

## Decision

### 1. A tag is a string; a SCOPED tag is `key:value`

A **scoped tag** is a string of the form `key:value` where both halves are
lowercase identifiers (`[a-z][a-z0-9-]*`, the facet-name grammar) and there
is exactly one colon. `health:failing`, `priority:high`, `phase:design`. The
**key** names a dimension; the **value** is the box's, board's or note's
answer on it. GitLab spells the same idea `scope::value`; one colon is enough
here, because the identifier grammar leaves no ambiguity (`Machine
Learning`, `v1.2`, `foo:Bar` and `a:b:c` are all plain tags).

A **plain tag** is any other string OKF allows. It is preserved verbatim,
searched exactly, and never interpreted.

The grammar is checked on WRITE for scoped tags only — a write of `Health:
failing` is refused with the rule in the message — and never on read. That
is the two-sided shape ADR-0037 chose for the extension key: strict where
this codebase produces, lenient where it consumes.

### 2. Tags attach to markdown documents, to spatial documents, to nodes and to edges

- **Markdown documents**: unchanged, OKF core frontmatter `tags`.
- **Spatial documents**: the board gains `tags`. This closes the gap
  ADR-0009 decision 3 opened ("a spatial document lost `type`/`tags`"); a
  board is as taggable as a note. Stored in the native model; carried on
  `x-whiteboard.tags` for JSON Canvas and on the whiteboard extension for
  OCIF, both `extension` rows in their ledgers, lost in `strict` like every
  extension.
- **Nodes**: a node gains `tags`, stored and projected the same way.
- **Edges**: an edge gains `tags` too, in the first scope (owner decision,
  2026-09-16). The use case is the infrastructure diagram: a link between
  two services is healthy or failing as much as the services are, and a
  reader asks the same question of the arrow as of the box. An edge is a
  RELATION (ADR-0038 decision 2), so a tag on it classifies the relation;
  stored and projected like a node's, on the edge extension both ledgers
  already carry.
- **Lines** (ADR-0038's ink, which asserts nothing about what is related to
  what) get no tags: a classification is a claim, and a line makes none.

A tag set is a SET: no duplicates, order carries no meaning, and a write that
adds a tag already present is a no-op rather than a second copy.

### 3. Several values under one key are ALLOWED, and every consumer says what it does with them

`hoge:foo` and `hoge:bar` on the same object is legal (owner decision,
2026-09-16). A box can be `region:eu` and `region:us`; a note can be
`topic:auth` and `topic:sync`. Exclusivity per key was considered and
rejected as a default because it is a modelling claim about the key, not
about tags, and the vocabulary is payload — there is no place to declare it
without a library (decision 5), and a rule nobody declared should not refuse
a write.

What follows is per consumer, and each is stated so a multi-valued key never
surprises:

- **Search.** `wb_document_search`'s `tags` filter matches an object that
  carries every listed tag exactly, as today. A spatial document matches when
  its board, any of its nodes or any of its edges carries the tags; the
  answer names the matching nodes and edges as excerpts, an edge by its
  label or its two ends. No wildcard in this decision; a key filter
  (`health:*`) is a later addition if the lane asks for it.
- **The facet score.** The population is EVERY box on the board, tagged or
  not, exactly as it is for the three partitions the score already knows:
  a box carrying no value under K is its own class, the way a box wearing
  no stencil is the `''` class today, so a half-classified board still
  reads and is not silently narrowed to the boxes somebody got round to.
  A key K is then a PARTITION when every box carries at most one value
  under K — needing no declaration, the reading `semantic.class/v0` had —
  and colour is `carried(K)` only when it is constant within every class,
  the untagged class included: five failing boxes in red, one healthy in
  green and one untagged in red read as carried, while two untagged boxes,
  one red and one green, read as contested — the untagged class is judged
  like any other, never skipped. (Corrected when increment 2 calibrated it:
  the first wording had a single untagged box in green reading as
  contested, which the stated rule does not give — one box is constant
  within its own class.)
  When any box carries two or more values under K, K is not a partition:
  the score reports it as `multi` with the count of such boxes, and no
  channel can read `carried(K)`. A key that is a partition on one board and
  `multi` on another is judged per board, because that is the truth of
  each board. Plain tags are multi-valued by nature and are never a
  partition; the board's own tags are one object's and are not one either.
  This is the principled reading ADR-0033 asked for: tags in general are
  not a partition, scoped keys used at most once per box are.

  Edges get the same reading over their own population, every edge on the
  board with the untagged ones as their own class: a key partitions a
  board's edges when every edge carries at most one value under it, `multi`
  otherwise, judged separately from the boxes — a key can partition the
  boxes and be `multi` on the edges. The score reads NO edge channel today
  (its channels are a box's colour and shape), so this decision adds one,
  the edge's colour, carried or contested by an edge key exactly as a box's
  colour is by a box key. A second edge channel (the stroke's style) is not
  claimed until a board shows a distinction spent on it.
- **The legend (decision 6).** Only keys colour is `carried` by are drawn
  with swatches — a filled swatch for a box key, a line swatch for an edge
  key. A `multi` key is not: colour cannot mean two things on one box or one
  arrow, and a legend that said it did would be a promise the drawing does
  not keep.
- **The editor.** Chips. A node showing `health:failing` and
  `health:degraded` side by side is the honest picture of what it carries;
  the panel does not collapse them.
- **The MCP write path.** `tags.add` adds, `tags.remove` removes by exact
  string. Replacing one value under a key is `remove` the old and `add` the
  new; there is no "set the value of key K" verb, because that verb would
  presume the exclusivity this decision declines to assume.

### 4. `semantic.class/v0` retires; the words are tag, key, value

The facet, its plugin's only member, its built-in partition in the score, the
Facets panel form it derived, its eval positive control and its smoke step
are replaced by scoped tags. `semanticPlugin` stays registered with no
facets until decision 5 gives it one, or is removed if that decision is not
taken; an empty plugin is not worth keeping for its name.

`axis` leaves every user-facing surface. `visual.axes/v0` keeps its name: it
declares which FACET keys the score treats as partitions, which is a
different thing from a tag key and is still needed for a facet-carried
distinction (a stencil, a shape). `.claude/rules/vocabulary.md` gains rows
for **Tag**, **Scoped tag**, **Key** and **Value**.

### 5. Tags are MANAGED at two levels: what is in use, and what is declared

The owner asked for a management mechanism, and there are two things to
manage.

**In use** (this decision, first increments): the vocabulary a workspace has
already spent. A read tool answers, per workspace, every tag with its count
by object kind, grouped by key for scoped ones, counted separately for documents, boards, nodes
and edges — the same shape the editor's suggestions are built from. Rename
and merge are bulk writes over the workspace: `rename` turns every
`health:degraded` into `health:failing` across documents, boards, nodes
and edges in one operation, and is what makes a typo recoverable. Whether these ride `wb_facet_set`'s `tags` change with a
workspace-wide target or a tool of their own is priced on ADR-0031's
scoreboards by the increment, not decided here.

*Priced (increment 3):* `tags.rename` rides `wb_facet_set`, applied to the
documents named (a workspace-wide rename is a listing plus one call over up
to fifty ids). It cost ~350 model-visible bytes and 3 described parameters
inside the write verb a model already reaches for; a `wb_tag_rename` tool
measured 987 visible bytes and 5 parameters as a row of its own. The in-use
listing rides `wb_facet_list` with a `workspaceId`, output-only on the wire
(+572) and one clause in the description (+65 visible).

**Declared** (a later increment, this decision only names it): a workspace
TAG LIBRARY document, the shape ADR-0034 decision 4 and its amendment fixed
for stencils — payload under a registered schema, per workspace, composed
into a synthetic plugin, cached on the library's version. It declares keys,
the values a key admits, a colour per value, and a description per key. It
is what turns a key's values into the legend's swatches by intent rather
than by observation, and it is the only place exclusivity per key could be
declared if a workspace wants it. It is deferred because the in-use layer
delivers the whole UX finding without it, and because a library document
that nobody has needed yet is the "we ship it for them" failure ADR-0034
warned against.

### 6. The reading surfaces: chips in the editor, a legend on the board

- **Facets panel**: the Meaning group's form is replaced by a tag row on the
  same panel, for a node, for an edge (the panel already takes an edge as
  its subject) and for the board: chips of what is carried, one input that
  takes `key:value` or a plain tag, suggestions of keys and of values under
  the key being typed (the pairing the datalist could not do), and a chip's
  own close control to remove it. The document header's
  existing tag editor is the same control, so a note and a box are tagged the
  same way. The panel's group ORDER is decided at the same time: Visual style
  first, tags after, declared once in the engine rather than left to plugin
  ids.
- **Legend**: a corner overlay on the board, shown only when the score reads
  a colour as `carried` by at least one key, listing that key's values with
  their swatches, boxes and edges each in their own kind of swatch;
  collapsible; the same component rendered into SVG and PNG
  export. When colour is spent and no key carries it, one muted line says so.
  Not in the panel: a legend is for the reader, and the reader has no panel.

  *Landed (increment 4b): the legend is the LAYOUT's answer — `canvasLegend`
  derives it from the facet score and the appearance the layout paints with,
  and `layoutSpatialCanvas` attaches it to the top-level scene (never to a
  miniature). The SVG backend draws it in the top-left corner of an
  enveloped document, in a band `sceneDocumentBounds` reserves on the left
  so it covers no content, so every export and the viewer carry it; the keyed
  projection the editor patches from omits it and the editor draws the same
  data as its own overlay. Only a scoped-tag key is listed: a frame, a kind
  or a stencil that carries the colour has no values a legend can name.*

  *Landed (increment 4c): the workspace's vocabulary as the document
  browser's tag strip — `WorkspaceFilesSource.listTagsInUse`, the daemon's
  `GET /document-tags` `inUse` and the browser keeper's own count over notes,
  boards, boxes and edges (`lib/tags-in-use.ts`, the twin of server-core's),
  grouped by key with a count of what carries each tag. The browser keeper's
  list also carries a board's own tags now, which it did not before.*

### 7. The tool surface is measured, not assumed

Two changes reach what a model reads and each runs ADR-0031's ladder:

- `wb_facet_set` accepts `tags` on a spatial document, with a `nodeId`, and
  with an `edgeId` — the edge target it already takes for facets, validated
  the same way (the edge must exist on the one document named) — which is a
  description change (rung 1) and a lane task (rung 3): the
  "tell two things apart" task, unchanged, with its verifier reading scoped
  tags. That reading is round 19: **0 of 3, no tag written** — two trials
  coloured and recorded nothing, one recorded health as a badge the board
  does not draw (ADR-0031's twenty-third reading). The twenty-second
  reading's open question — whether the prompt should ask for the meaning
  to be recorded — is still open and is not answered by this ADR.
- An inline `tags` field on `node.add` / `node.patch` is PRICED before it is
  bought (measured when the model gained the field, increment 1: letting it
  reach the node drafts and the edge draft/patch read +6 undescribed
  parameters and +300 visible bytes on `wb_canvas_edit`, so the drafts omit
  it until round 19 says a model reaches for it): the same measurement as ADR-0036 §6's `facets` field, with the same
  withdrawal rule written before the run. Tags may behave differently from a
  facet — models write document tags unprompted — and that is exactly the
  kind of claim the lane exists to test rather than argue.

## Consequences

- One word for one thing, on every surface: a person, the panel, the tools
  and the ADRs all say tag. The UX finding's first and third points (the
  words, and the value-by-key pairing) are dissolved rather than solved; its
  second and fourth (group order, legend) are decided in decision 6.
- The model gains three positions (`tags` on the board, `nodes[].tags`,
  `edges[].tags`), all `extension` in both projection ledgers;
  `json-canvas-reach` and the OCIF ledger move by +3 and say why.
- The facet score gains its first edge reading (the edge's colour), which
  is an instrument change and is calibrated the way the box channels were:
  a board with edges coloured by a key reads `carried`, the same board with
  the key removed reads `contested`, and a planted `multi` key reads
  neither.
- ADR-0033's `tags` omission closes with a rule that admits multi-valued keys
  honestly (`multi`) instead of forcing a partition.
- The structure of a scoped tag lives in a string. That is a convention, and
  ADR-0013 exists because conventions breed by accident. The mitigation is
  that the grammar is the MODEL's, checked at every write this codebase
  performs, rather than a habit — the same status the facet-key grammar has.
- Renaming a tag is a bulk write across a workspace, which is new. It goes
  through the same history every write does, so a rename is a version on
  every document it touched.
- Foreign OKF documents with plain tags round-trip unchanged. A foreign
  document that happens to carry a lowercase `foo:bar` is read as scoped,
  which is the reading every convention using a colon would give it.

## Alternatives considered

- **Keep `semantic.class/v0`, relabel the screen.** Rejected by the owner:
  the screen and the tools must speak one language.
- **Keep the facet, rename both sides to one word.** Considered — cheap,
  since the facet is v0 with no data — and rejected because it leaves two
  labelling mechanisms in place, one for notes and one for boxes, differing
  in shape and surface for no reason a user can see.
- **Exclusive per key by default.** Rejected: a claim about the key with no
  place to declare it. Kept available through the library (decision 5).
- **Structured tags (`{key, value}` objects) instead of a string grammar.**
  Rejected: OKF's `tags` are strings, every existing reader (search, the
  eval tasks, the document header) speaks strings, and a string is what a
  person types and an agent writes. The grammar buys the structure without a
  second shape.
- **Tags on edges deferred.** The first draft deferred them for want of a
  use case; the owner supplied one (an infrastructure link that is healthy
  or failing), and an ADR that classified the box and not the arrow would
  have left the reader's question half answered.
- **Tags on lines.** Rejected: ink asserts nothing, so it has nothing to
  classify (ADR-0038 decision 2).
- **A tag library first.** Deferred; the in-use layer answers the finding,
  and a library nobody has asked for is the failure ADR-0034 named.

## Increments

Each is a PR with its own tests, in dependency order (`architecture-map.md`
fixes the direction):

1. **Model and codec**: `tags` on the spatial document, on nodes and on
   edges; the scoped-tag grammar and its write-side check; both projection
   ledgers and `json-canvas-reach`; round-trip properties.
2. **The score**: keys as partitions with the `multi` rule, over boxes and
   over edges; the edge colour channel, calibrated; `semantic.class`'s
   partition removed; the eval positive control and the two-axis verifier
   read tags.
3. **Tools and search**: `wb_facet_set` tags on boards, nodes and edges;
   search reaching node and edge tags; the in-use listing; rename/merge,
   priced; the inline canvas-op field, priced; round 19; `semantic.class/v0`
   retired; smoke.
4. **The editor**: the tag row in the Facets panel for nodes, edges and
   boards, the document header sharing it; group order declared; the legend
   on the board and in export; a tags panel for the workspace's vocabulary
   in use.
5. **The library** (when asked for): the declared layer of decision 5.
