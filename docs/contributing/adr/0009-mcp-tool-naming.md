# ADR-0009: MCP tool naming — `wb_<entity>_<action>`

**Status:** Proposed

## Context

The MCP tool surface grew one tool at a time and now carries three naming
conventions at once. Counting the tools actually registered (excluding the two
MCP Apps UI tools, which are a different contract — see below):

| convention | tools |
|---|---|
| `wb_canvas_*` | `wb_canvas_create`, `wb_canvas_delete`, `wb_canvas_get`, `wb_canvas_list` |
| `canvas_*` | `canvas_digest`, `canvas_export_json_canvas`, `canvas_export_okf`, `canvas_import_okf`, `canvas_render_svg` |
| no prefix | `body_patch`, `edge_lock`, `edge_patch`, `facet_set`, `node_lock`, `node_patch`, `tidy_canvas`, `version_list`, `version_restore`, `version_save` |

Ten of nineteen have no prefix at all. `tidy_canvas` is additionally the only
one ordered action-first.

Three things surfaced while scoping this, each of which changed the answer.

### 1. Tool names are the whole description

No registered tool has a `description`. `registerToolWithAnnotations` is
called with `inputSchema` and `outputSchema` only. An MCP client shows agents
whatever description a tool carries, so today the name *is* the documentation —
which makes naming load-bearing rather than cosmetic, and makes "the schema
explains it" an unavailable defence.

### 2. `canvas_import_okf` is not an import, and not a creation path

It calls `assertCanvasInWorkspace` and requires an **existing** `canvasId`;
`wb_canvas_create` makes the canvas and this fills it. It then calls
`writeCoreFacets` + `writeFacets` + `writeSpatialCanvas`, replacing the whole
content. So it is neither "create" (the canvas already exists) nor "import"
(nothing arrives from outside — a string argument is parsed into a document
that is already there). It is a whole-document replace.

### 3. `wb_canvas_get` returns no content, which is why export/import read as odd

`getCanvasOutputSchema` is `canvasDetailSchema` — `{ canvasId, segment, alias }`.
Identity and location, nothing else.

That is the crux. The thing `canvas_export_okf` serialises is **not** the
entity `wb_canvas_get` returns. Two different entities were sharing one noun:
the canvas (where it is, what it is called) and its document (what is in it).

### 4. `canvas_digest` and `tidy_canvas` are not canvas-general

`tidy_canvas` parses through `spatialCanvasSchema`, so it is spatial-only — a
markdown canvas cannot be tidied. `canvas_digest` runs
`loadSpatialCanvas` → `composeCanvasScene` → `sceneDigest` and returns
`sceneDigestSchema`. Both are named for the canvas and both operate on the
laid-out spatial projection.

`canvas-render` already has the word for that projection: `sceneDigest`,
`composeCanvasScene`, `renderSceneToSvg`. The vocabulary existed; the tool
names did not use it.

## Decision

1. **Every tool is `wb_<entity>_<action>`.** One prefix, entity before action,
   no exceptions among the tools listed below.

2. **The entity is what the tool acts on, not the file it lives in.** The
   resulting surface:

   | entity | what it is | tools |
   |---|---|---|
   | `canvas` | identity and location | `wb_canvas_create`, `wb_canvas_delete`, `wb_canvas_get`, `wb_canvas_list`, `wb_canvas_tidy` |
   | `document` | the whole content | `wb_document_get`, `wb_document_set` |
   | `body` | part of the content — the markdown body | `wb_body_patch` |
   | `facet` | part of the content — the metadata | `wb_facet_set` |
   | `node` / `edge` | part of the content — spatial elements | `wb_node_patch`, `wb_node_lock`, `wb_edge_patch`, `wb_edge_lock` |
   | `scene` | the laid-out projection | `wb_scene_digest` |
   | `version` | history | `wb_version_save`, `wb_version_list`, `wb_version_restore` |

   `document` is not a new word: `OkfMarkdownDocument`, `LoroDoc`,
   `CanvasDocStore` and `canvas-doc-io.ts` already use it for exactly this.
   The layering it introduces — `document` is the whole, `body`/`facet`/`node`/
   `edge` are parts of it — is readable off the names.

3. **Format is a parameter, not an entity.** `canvas_export_okf`,
   `canvas_export_json_canvas` and `canvas_render_svg` collapse into
   `wb_document_get(format)`; `canvas_import_okf` becomes
   `wb_document_set(format)`. Nineteen tools become seventeen.

   This is what makes the gaps visible instead of absent. Today "there is no
   JSON Canvas import" is expressed by a tool nobody wrote — unobservable from
   `tools/list`. As enums it is a difference between two schemas: `get` accepts
   `okf | json-canvas | svg`, `set` accepts `okf`. SVG being render-only lands
   the same way, as an enum member `get` has and `set` does not.

4. **`tidy` belongs to `canvas`, not `scene`.** Selecting several nodes is
   still selecting elements *within* a canvas, so the operation's scope is the
   canvas even when its input is a subset. This also keeps `scene` to what it
   is — a derived, read-only projection — rather than giving it a write.

5. **Every tool gains a `description` in the same increment as its rename.**
   Point 3 trades two tool names for one enum, which is only an improvement if
   the enum is discoverable. Renaming without descriptions would make the
   surface harder to read, not easier.

6. **The two MCP Apps tools keep their names.** `canvas_open` and `canvas_view`
   are a UI contract with the MCP Apps host rather than part of this data-plane
   surface, and are out of scope here.

## Consequences

- Sixteen of nineteen tools change name. At `0.0.19` this ships as a plain
  rename with no deprecated aliases — a pre-1.0 surface is the cheapest moment
  this will ever be, and carrying both names would double the surface that has
  no descriptions to disambiguate it.
- Every agent configuration, skill, or script naming a current tool breaks.
  In-repo that is `packages/mcp-server/scripts/smoke/mcp-e2e-smoke.mjs`, the
  registration in `packages/mcp-server/src/server/mcp/opencanvas-tools.ts`, the
  definitions and schemas under `packages/server-core/src/tools/`, and nine
  files under `docs/`.
- A stale duplicate has to go with it:
  `packages/mcp-server/scripts/mcp-e2e-smoke.mjs` differs from the live
  `scripts/smoke/mcp-e2e-smoke.mjs` and is run by nothing, while
  `.claude/skills/zod-schema-discipline/SKILL.md` points at that dead path.
  Left alone, the rename sweep would leave old names alive in the file the
  skill tells people to edit.
- `wb_document_get`/`set` take a format the caller must choose, where three
  separate tools previously chose for them. The description added under point 5
  is what keeps that from being a regression in discoverability.
- `facet` remains one entity covering two origins: core facets are OKF
  frontmatter (`type`/`title`/`tags`), extension facets (`{domain}/{version}`)
  are this project's own. This ADR does not split them — that belongs with the
  facet-schema discussion that retiring `issue/1` opens.

## Alternatives considered

**Keep the format in the tool name (`wb_okf_get`, `wb_json_canvas_get`).**
Rejected, though it was the first proposal here. It makes the two formats
visible in `tools/list` without reading a schema, which is a real advantage
while no tool has a description. But it treats a serialisation format as a
peer of `canvas` and `version`, which it is not — and it spreads one operation
across three tools whose only difference is an output encoding, so every future
format is a new tool rather than an enum member.

**Name the write side `wb_canvas_import` for symmetry with `export`.**
Rejected: it inherits exactly the vocabulary problem this ADR set out to fix.
Nothing is imported — there is no outside. Worse, `export`/`import` on the
`canvas` entity would claim to act on what `wb_canvas_get` returns, which is
identity, not content.

**Name it `wb_canvas_create` and treat it as the creation path.** Rejected on
the evidence in Context point 2: the canvas must already exist, and the same
tool is the whole-document replace path. `create` would be a worse name than
`import`, not a better one.

**Leave `tidy` on `scene`.** Rejected under point 4, but it is the closer call
of the two: `tidy` reads the laid-out scene to decide placement, so `scene` is
defensible as its input. It loses on what the tool *writes* — node positions in
the spatial document — and on `scene` otherwise being a read-only derivation.

**Rename nothing and add descriptions instead.** This would fix the discovery
problem without breaking a single caller, and is genuinely tempting. Rejected
because the names would still contradict the code — `canvas_import_okf` acting
on an existing canvas, `canvas_digest` returning a scene digest — so each
description would exist to apologise for its own tool's name.
