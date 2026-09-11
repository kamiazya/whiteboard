# ADR-0033: The document model is native; JSON Canvas and OKF are projections

**Status:** Proposed — awaiting a human gate. Nothing is implemented. Re-points [ADR-0009](0009-mcp-tool-naming.md)'s lossy-projection rule at the STORED model rather than at output alone, and stands on the census landed in `packages/codec/src/spatial/census.ts`.

## Context

A whiteboard spatial document IS a JSON Canvas 1.0 document plus one extension
key. The model package holds `spatialCanvasSchema`, and that schema is the
format. The standing question is whether the product can keep growing that way.

Measured rather than argued. A corpus cannot answer it — a corpus answers what
somebody happened to draw — so `censusSpatialModel` reads the schemas and counts
every leaf field position a document can hold:

| | field positions |
|---|---|
| stated by JSON Canvas 1.0 | 23 |
| named on `x-whiteboard` | 12 |
| inside the facet buckets, from the one bundled plugin | 15 |
| **outside the format** | **27 of 50 (54%)** |

Three of those positions are facet BUCKETS, which the census reports as
unbounded rather than descending: at the model level a bucket is
`Record<facetKey, unknown>`, so the format can say a bucket is present and
nothing about what is in it. The 15 expanded positions come from a single
plugin, and the facet system exists to accept more — so that column grows by
construction, not by anyone's choice.

`strictDegrade` drops all 27. Strict JSON Canvas export is therefore not a
degradation of the document; it is the deletion of most of what the document
means.

What the census cannot see is what the model was never allowed to hold. From
recent work:

| wanted | what refused it | where it ended up |
|---|---|---|
| a standalone stroke, an arrow to nowhere | `canvasEdgeSchema` requires `fromNode` and `toNode` | not built |
| an `ink` node kind | the node `type` union is closed to `text｜file｜link｜group` | not buildable |
| bend points on an edge | the edge schema is JSON Canvas 1.0 itself | `visual.path/v0` plus a contributed router |
| curves, rotation, sub-pixel geometry | JSON Canvas 1.0 geometry is integer pixels | not built |
| proposals ([ADR-0029](0029-proposal-layer.md)) | no site on the canvas to put them | the Loro tree only — they reach NEITHER export mode |
| comments ([ADR-0024](0024-canvas-comments.md)) | the shape that stores well is not the shape that exports | a standing translation layer |

The bend row is the shape of the cost. Adding a field to an edge became a facet
definition, an `EdgeRouter` contract and the extraction of `packages/scene`.
The result is a better seam, and half the motivation was not to break a foreign
format.

The markdown side is already most of the way to where this ADR wants to be, and
that is the existence proof. `parseOkf` routes every unmodelled root key into
`facetsRaw` and spreads it back on serialise (OKF §4.1), so the model claims to
be a SUBSET of OKF rather than to be OKF. The spatial side never got that
treatment.

One force pulls the other way and has to be answered rather than dismissed:
**the format has been supplying discipline.** The node vocabulary is four kinds
because it was not ours to extend. A model designed freely, with nothing
refusing anything, is how a model hollows out.

## Decision

**1. `packages/model` holds a native document model. JSON Canvas 1.0 and OKF
Markdown stop being it.**

The native model is designed for what the product means. `packages/codec` gains
`toJsonCanvas`/`fromJsonCanvas` beside the OKF pair it already has, and both
directions are explicitly lossy in one direction — the position ADR-0009
already takes for `wb_scene_render`'s SVG, applied to the stored model instead
of only to output.

**2. First-party support means a tested projection, not an identity.**

Today the claim rests on the model being the format. It becomes: a round-trip
property over the JSON-Canvas-expressible SUBSET (lossless in that subset), plus
a published loss table for everything else. This is a weaker-sounding claim and
a stronger one — the current claim cannot be checked, and this one fails a test
when it stops holding.

**3. The native model's first gains are the rows above, and nothing
speculative.**

Free endpoints on an edge (a node reference or a point), bends as a field,
`number` coordinates, a stroke as a node kind, and comments and proposals as
document-level collections. Each field shape is designed in its own slice; what
this ADR decides is only that these are native-model citizens rather than
extension payload.

A NEW first-class field afterwards earns its place by three answers, or it stays
a facet: a user can observe or author it; at least two surfaces read it; and it
declares its projection per decision 4. **This does not retire
[ADR-0013](0013-facet-system.md).** Facets remain how a plugin contributes
meaning. What changes is that core product concepts stop having to pretend to be
plugin data in order to exist.

**4. Every native field declares how it projects, and a ledger holds it.**

```
native | extension | degraded(to) | dropped(why)
```

`native` survives strict JSON Canvas; `extension` rides `x-whiteboard` and dies
in strict; `degraded` names what it becomes (a stroke → a `file` node; a float
coordinate → a rounded integer); `dropped` says why it cannot cross at all.

The table is checked in all four directions of
`.claude/rules/coverage-ledger.md` against the census's own path list, which the
type system cannot enumerate: a new field with no entry fails, an entry naming
a field that no longer exists fails. This is the rung that replaces the
format's refusals. A model free to grow, with nothing forcing anyone to say
what growing costs the export, is the failure mode this ADR would otherwise
create.

**5. Loro stores the native model.**

`loro-adapter` stops bridging to the JSON Canvas shape. The native model is a
superset, so reading an existing record is a total lift through the JSON Canvas
parser — no row is lost and no document needs rewriting before it is read.

**6. OKF's remaining step is narrower, and is sequenced last.**

The parse side already preserves rather than models. What is left is that
`okfMarkdownFrontmatterSchema` is published as `wb_document_get`'s
`outputSchema`, so the format is the published READ shape. Moving that to the
native shape is a change to what a model reads of a tool and goes through
[ADR-0031](0031-tool-surface-criteria.md)'s criteria on its own.

**7. Order.** Dependency-stacked, per `.claude/rules/architecture-map.md`:
`model` → `codec` (projections, loss table, round-trip property, the census
re-pointed at projection loss) → `loro-adapter` → `scene`/`canvas-render` →
`server-core`/`mcp-server` → `apps/web` → OKF's step 6.

## Consequences

Easier: a stroke, a curve, an edge that ends in space, one shape for a comment
instead of two, a proposal that can leave the workspace at all, and a loss table
a user can read before choosing an export mode.

Harder: every field now costs a projection decision, and the seam has two shapes
where it had one. The round-trip property becomes load-bearing rather than
confirmatory. `wb_document_get`'s published output shape changes, which is a
tool-surface change with its own gate. Every package in the table touches this,
so it is a stack of increments rather than a change.

The named risk is decision 3's: a model nobody refuses. The criterion and the
ledger are the answer, and their adequacy is exactly what a reviewer of this ADR
should attack.

## Alternatives considered

**Keep the model as the format.** Refuted by the census: 54% of the document's
field positions are already outside it, the facet column grows by construction,
and six concrete designs have already been bent or blocked.

**Make `x-whiteboard` the model — widen the extension instead.** This is the
status quo with a better name. Strict export still deletes the product, the
facet buckets are still untyped from the format's side, and an edge still
cannot end in space, because the edge's own required fields are the constraint.

**Propose the extensions to JSON Canvas upstream.** Not in this project's gift,
on a timescale nobody here controls, and it does nothing for OKF.

**Drop first-party JSON Canvas support.** Rejected. Interop is a real promise to
users and the format is a good one. The point of this ADR is to keep the promise
and stop paying for it in the model.
