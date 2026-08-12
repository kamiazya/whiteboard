# ADR-0009: The Document model, and `wb_<entity>_<action>` tool naming

**Status:** Accepted

## Context

This started as a tidy-up of MCP tool names and turned into a model
correction, because every naming question kept resolving to "these two names
are fighting over one concept". The naming decision is downstream of the model
one, so both are here.

### The tool surface carries three conventions

Nineteen data-plane tools (excluding the two MCP Apps UI tools, out of scope
below):

| convention | tools |
|---|---|
| `wb_canvas_*` | `wb_canvas_create`, `wb_canvas_delete`, `wb_canvas_get`, `wb_canvas_list` |
| `canvas_*` | `canvas_digest`, `canvas_export_json_canvas`, `canvas_export_okf`, `canvas_import_okf`, `canvas_render_svg` |
| no prefix | `body_patch`, `edge_lock`, `edge_patch`, `facet_set`, `node_lock`, `node_patch`, `tidy_canvas`, `version_list`, `version_restore`, `version_save` |

Ten of nineteen have no prefix. `tidy_canvas` is the only one ordered
action-first.

### Tool names are the entire documentation

No registered tool has a `description` — `registerToolWithAnnotations` is
called with `inputSchema` and `outputSchema` only. An MCP client shows agents
whatever description a tool carries, so a name here is not a label on
documentation, it *is* the documentation. "The schema explains it" is not an
available defence for any name below.

### "Canvas" is doing two jobs, and one of them is a category error

`canvasKindSchema` is `z.enum(['spatial', 'markdown'])`. A markdown note is
not a kind of canvas; it is a kind of document that happens to live beside
one. The word was chosen when spatial was the only kind and has been carrying
the container concept ever since.

Meanwhile `wb_canvas_get` returns `canvasDetailSchema` —
`{ canvasId, segment, alias }`. Identity and location, no content at all. So
what `canvas_export_okf` serialises is not the entity `wb_canvas_get` returns.
Two different things share the noun.

`meta.ts` makes the confusion literal: its field is named `format` and its
type is `canvasKindSchema`. Kind and format are already the same field.

### The name of a document is stored twice

`canvases.displayName` (surfaced as `WorkspaceNames.canvases[slug]`, and what
the UI shows) and the OKF core facet `title` both hold "what this document is
called". `apps/web` already resolves the conflict by hand:
`fallbackCoreMeta(canvasKind, canvasName)` seeds the facet `title` from the
workspace-level name when the facet is absent.

That fallback is the model telling us where naming belongs. A document's name
is a property of its place in the workspace, not of its content — and the
second copy inside the content is what makes it ambiguous which one wins.

### Facets are OKF's frontmatter, but every document carries them

OKF — the [Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing),
Google Cloud's open spec published June 2026 — requires exactly one
frontmatter field, `type`, and recommends `title`, `description`, `resource`,
`tags`, `timestamp`. This project's `canvasCoreMetaSchema` is `type` (required)
plus `title` and `tags`. That is not a coincidental resemblance; the core
facets *are* OKF frontmatter.

JSON Canvas has no frontmatter concept — it is `{ nodes, edges }`.

Yet today a spatial document carries core facets too: `CanvasProperties` is
mounted for both kinds. So a JSON-Canvas-shaped document holds OKF frontmatter
it has no way to serialise, and a markdown document holds `nodes`/`edges` maps
it never uses. One Loro document is a flattened union of every format's
structure.

### `digest` and `tidy` are not canvas-general either

`tidy_canvas` parses through `spatialCanvasSchema`, so it is spatial-only — a
markdown document cannot be tidied. `canvas_digest` runs
`loadSpatialCanvas` → `composeCanvasScene` → `sceneDigest` and returns
`sceneDigestSchema`. `canvas_render_svg` runs the same pipeline into
`renderSceneToSvg`. All three are named for the canvas; all three operate on
the laid-out projection `canvas-render` already calls a **scene**.

## Decision

1. **A workspace contains Documents.** `Canvas` stops being the container
   noun. It narrows to what it actually describes: the spatial surface, and
   the JSON Canvas format. This is a sharpening rather than a deletion — after
   this ADR the word is used correctly for the first time.

2. **Placement and naming are workspace concerns, and format-agnostic.** The
   segment, the derived alias, and the display name belong to the workspace
   tree. A document's content does not name itself.

   `title` therefore stops being stored twice. The workspace name is the one
   source; when a document is serialised to OKF, its frontmatter `title` is a
   **projection** of that name, not a second copy to keep in sync.

3. **Each format owns its own content structure. `Facet` belongs to OKF.**
   An OKF document has frontmatter (facets) and a markdown body. A JSON Canvas
   document has nodes and edges. Neither carries the other's shape, and a
   future third format adds only its own structure — because naming and
   placement, the parts every format would otherwise have to re-solve, are
   already handled by point 2.

   The cost is explicit: **a spatial document loses `tags` and `type`.**
   Metadata on a diagram is a reasonable thing to want, and this ADR does not
   smuggle it back through facets. It is a workspace-level capability that
   does not exist yet, and saying so plainly is the point — the alternative
   (facets as format-agnostic document metadata) is rejected below for making
   every new format re-litigate how metadata is represented.

4. **A document's format follows from the document, not from a parameter.**
   *(Not implementable yet — see the note under Consequences.)*
   Because the structures are separate, "read this document as OKF" is only
   meaningful for an OKF document. `wb_document_get` returns the document in
   its own format; `wb_document_set` replaces it in that format.

   Cross-format projections are a separate, explicitly lossy concern. The one
   that exists today is SVG, which is a *render* of a laid-out scene rather
   than a serialisation of stored content — so it is `wb_scene_render`, with
   its own output schema, not a format enum on the document read.

5. **Every tool is `wb_<entity>_<action>`.** One prefix, entity before action:

   | entity | what it is | tools |
   |---|---|---|
   | `document` | the unit a workspace contains | `wb_document_create`, `wb_document_delete`, `wb_document_get`, `wb_document_list`, `wb_document_set` |
   | `facet` | OKF frontmatter | `wb_facet_set` |
   | `body` | the OKF markdown body | `wb_body_patch` |
   | `node` / `edge` | JSON Canvas elements | `wb_node_patch`, `wb_node_lock`, `wb_edge_patch`, `wb_edge_lock` |
   | `canvas` | the spatial surface | `wb_canvas_tidy` |
   | `scene` | the laid-out projection | `wb_scene_digest`, `wb_scene_render` |
   | `version` | history | `wb_version_save`, `wb_version_list`, `wb_version_restore` |

   `document` is not a new word: `OkfMarkdownDocument`, `LoroDoc`,
   `CanvasDocStore` and `canvas-doc-io.ts` already use it for exactly this.

   `wb_canvas_tidy` keeps `canvas` deliberately. Selecting several nodes is
   still selecting elements *within* a canvas, so the operation's scope is the
   surface even when its input is a subset — and under point 1 `canvas` now
   means precisely that surface.

6. **Descriptions land in the same increment as the renames**, written as
   `.describe()` on the Zod shapes so validation and tool metadata cannot
   drift. Point 4 removes a format enum and point 5 moves fifteen names; both
   are only improvements if the result is discoverable, and today nothing is.

7. **The MCP Apps tools keep their names.** `canvas_open` and `canvas_view`
   are a UI contract with the MCP Apps host, not part of this data plane.

## Consequences

- **Decisions 3 and 4 describe a target, not the shipped state.** Implementing
  point 5 surfaced that the OpenCanvas document persists no format at all:
  `canvas-crud.schemas.ts` has no `kind`/`format` field, so document creation
  records none, and `loro-bridge.ts` stores none. Both exporters consequently
  work on *any* document — `canvas-export-okf.ts` says so itself, using a
  placeholder `type: 'canvas'` for "a spatial-only canvas that never went
  through" the set path. One Loro document still holds `core`, `facets`,
  `nodes` and `edges` together.

  The format does exist, in the *other* store: `canvasKindSchema` and the
  daemon's workspace/slug `kind` column. These tools read the OpenCanvas doc
  store. This is ADR-0007's two-store split again, the same wall ADR-0008
  point 4 met with alias history.

  So `canvas_export_okf` and `canvas_export_json_canvas` keep their old names
  until a format is persisted — the tool surface is seventeen renamed plus
  those two. Inferring the format from content ("does it have nodes?") is
  specifically rejected: a markdown document gains a node the moment anyone
  embeds one, and the inference flips silently.

- **Every one of the nineteen tools changes name.** Even the four already
  prefixed `wb_canvas_*` move, because point 1 makes the container a
  Document: `wb_canvas_create`/`_delete`/`_get`/`_list` become
  `wb_document_*`. There is no tool a caller can keep. Backward
  compatibility is explicitly not a goal: at `0.0.19` this ships as a plain
  rename with no aliases.
- **Two of the nineteen are not renames at all.** `canvas_export_okf` and
  `canvas_export_json_canvas` collapse into one `wb_document_get` that
  branches on the document's format, which is new logic rather than a new
  label — worth landing as its own increment, separate from the fourteen
  one-to-one renames, so a reviewer is not reading a mechanical sweep and a
  behaviour change in the same diff.
- The rename is not confined to the tool surface. `canvasId`, `CanvasDocStore`,
  `canvas-store.ts`, the `/canvas/:ws/:slug` route, UI copy, and the
  `@kamiazya/whiteboard-canvas-*` packages all carry the old container noun.
  All those packages are **private**, so renaming them breaks nothing outside
  this repo; the published surface is `@kamiazya/whiteboard-mcp` alone, plus
  URLs that users may have bookmarked.
- **Spatial documents lose `type`/`tags` and the properties bar they were
  wired into.** This is the sharpest user-visible consequence of point 3 and
  it is a deliberate removal, not an oversight — the replacement is
  workspace-level metadata, unbuilt.
- `wb_document_get` no longer offers a caller-chosen format, so "export this
  spatial canvas as markdown" stops being expressible. Whether that conversion
  is worth building as an explicit lossy projection is a later question; today
  it exists only as a side effect of every document carrying every structure.
- A stale duplicate must go with the sweep:
  `packages/mcp-server/scripts/mcp-e2e-smoke.mjs` differs from the live
  `scripts/smoke/mcp-e2e-smoke.mjs` and is run by nothing, while
  `.claude/skills/zod-schema-discipline/SKILL.md` points at that dead path.
  Left alone, the rename leaves old names alive in the file the skill tells
  people to edit.
- Retiring the `issue/1` convention becomes easier to reason about, not
  harder: extension facets are now unambiguously an OKF-document concern
  rather than a general metadata system, so the question left open is only
  what OKF frontmatter this project standardises on.

## Alternatives considered

**Keep `Canvas` as the container and treat `Document` as its representation.**
Rejected. It preserves every current name and breaks no URL, and it was the
first proposal here. But it leaves `canvasKindSchema = ['spatial','markdown']`
intact — a markdown note remains a kind of canvas — and it keeps two nouns for
one thing, which is the condition this ADR exists to end.

**Facets as format-agnostic document metadata.** This is closest to today's
behaviour and it keeps `tags` working on diagrams, which point 3 gives up. It
was rejected because it defers the same decision to every future format: JSON
Canvas would need metadata smuggled into `x-whiteboard`, the next format would
need its own answer, and `facet` would go on meaning two different things at
once (OKF's frontmatter and this project's extension bucket) — which is
already the reason the current model is hard to explain.

**Keep the format in the tool name (`wb_okf_get`, `wb_json_canvas_get`).**
Rejected under point 4: once the structures are separate, a document has one
format and the caller does not choose it. Naming the format in the tool would
imply a conversion matrix that does not exist.

**Fold SVG into `wb_document_get(format=svg)`.** Rejected, and it was in an
earlier draft of this ADR — inconsistently, since the same draft argued
`canvas_digest` belongs to `scene` for exactly the reason that also applies to
SVG. Both run `composeCanvasScene`; a render is not a serialisation of stored
content.

**Name the write side `wb_document_import` for symmetry with `export`.**
Rejected: nothing is imported, there is no outside. The argument's own symmetry
is satisfied better by `get`/`set`, which also matches `wb_facet_set`.

**Rename nothing and add descriptions instead.** This fixes discovery without
breaking a single caller and is the cheapest option by a wide margin. Rejected
because the names contradict the code — `canvas_import_okf` acting on an
existing canvas, `canvas_digest` returning a scene digest, a markdown note
being a kind of canvas — so each description would exist to apologise for its
own tool's name.
