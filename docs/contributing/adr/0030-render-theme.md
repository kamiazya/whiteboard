# ADR-0030: A render theme is a document's pen and paper — a canvas facet naming a registered asset

**Status:** Accepted — design of record (human gate, 2026-09-09, after a four-round hearing). Nothing is implemented yet. Extends [ADR-0013](0013-facet-system.md) (names `visual.theme` and the `canvas-theme` slot) and binds canvas-render decision #10 (the render-style seam, `.claude/rules/package-canvas-render.md`).

## Context

The spatial canvas draws one look: straight-edged, one palette per mode. The
product wants a hand-drawn style and a neon style, and the standing claim was
that "the theme foundation is in place". Measured against the code, that claim
holds for COLOUR only:

- `createSpatialTheme({ mode, palette })` is the one appearance producer
  (decision #8), and its `palette` swap point is exercised by exactly one test
  and by no production call site. Every surface pins its own mode at the call
  site; the resolver is pushed down through `SpatialLayoutOptions.appearance`
  and spread verbatim into every embedded canvas.
- The scene graph's `Appearance` is a closed paint vocabulary (fill, stroke,
  width, dash, opacities, halo, a parameterless `dropShadow`). It cannot say
  "two jittered strokes" or "a coloured glow". The SVG element table allows
  `filter` on `rect` alone and knows one filter primitive, `feDropShadow`.
- Decision #10 fixed the ground a style lands on — style is a DOCUMENT
  property; geometry variance lives behind one shared decomposition per
  primitive; ink is decoration and semantic geometry stays authoritative;
  randomness is id-seeded and pure — and shipped exactly one piece of it:
  `layout/seed.ts`, imported by nothing.
- ADR-0013 names `theme` as a facet of the bundled `visual` plugin and
  specifies (decision 8) that a payload never carries raw styles but
  references a registered theme ASSET supplying token values. Neither the
  facet, the assets, nor decision 8's views/slots/kinds exist.
- The data side is ready: a canvas-target facet is a first-class shape, the
  `x-whiteboard.facets` bucket is where `visual.edges/v0` already lives, and
  an embedded canvas travels to the layout — worker boundary included — with
  its facets intact (`LoadedReference.canvas`).
- Two gaps sit beside it: `wb_facet_set` decides its target from `nodeId`
  alone, so no agent can write a canvas-target facet while `wb_facet_list`
  advertises them; and the `canvasSettings` contribution point has no
  derived-form vessel, so a canvas facet with only a tier-2 editor spec
  appears in no UI until hand-registered.
- Measured in this exploration, not read: `@resvg/resvg-js` 2.6.2 renders
  `feGaussianBlur`+`feMerge` glow and `feDropShadow` on rects, text, `<use>`
  symbols and curved paths — but a filter region declared relative to the
  element's bounding box drops an AXIS-ALIGNED STRAIGHT EDGE entirely, because
  its box has zero area. `filterUnits="userSpaceOnUse"` draws it. This is the
  SVG specification's behaviour, so a browser does the same.

The existing embed behaviour splits along a line worth keeping: appearance is
inherited from the outer call, while `visual.edges` and `visual.shape` are
read from the embedded canvas itself (pinned by `spatial-embed.test.ts`,
together with the guard that a root node's shape never leaks into a child).

## Decision

### 1. Two styles ship in one increment, each in both modes

`sketch` (hand-drawn: jittered multi-stroke outlines, hatched preset fills, a
handwriting face) and `neon` (a dark-first palette with a soft glow on
strokes, symbols and text). Every theme asset carries a `light` AND a `dark`
palette; the canvas surface follows the UI mode, exactly as today. A neon
document in a light UI is the neon asset's light half (a pale ground with
saturated strokes and a coloured halo), not a forced dark rectangle. Both
halves keep the palette floors decision #8 already pins: strokes ≥ 3:1
against the surface, label text ≥ 4.5:1 against the tint fill.

### 2. The selector is `visual.theme/v0`, a canvas facet naming a registered asset

```
visual.theme/v0   targets: ['canvas']
payload           { theme: '<plugin>.<name>' }     e.g. 'visual.sketch', 'visual.neon'
```

It lives INSIDE `visual`, as ADR-0013 lists it. A separate `theme` plugin was
weighed and buys nothing today: the engine has no assets, views or slots for
a separate plugin to stand on, so the separation would purchase a namespace
at the cost of a registry edit at every composition root, a hard-wired
registry in `SpatialEditor`, and a second tab in canvas settings. The
recorded trigger for revisiting is the one arch-lint already carries: "a
SECOND plugin wants to change how a node is drawn" converts canvas-render's
hard-coded `visual` dependency into injection, and that is the moment a
theme plugin could stand on its own.

The payload references an asset by NAMESPACED id, and the reference may
cross plugins: `{ theme: 'infra.aws' }` is valid once an `infra` plugin
registers such an asset. This is a deliberate exception to `visual.shape`'s
rule that a document cannot name another plugin's geometry, and it is scoped
to ASSETS only — reuse across plugins is the point of an asset. Two guards
hold it: the registry validates the id's existence on write (`wb_facet_set`
and the editor both go through `validateFacetWrite`), and a render that meets
an unknown id draws `clean` and reports `onDegrade({ kind: 'unknown-theme' })`.

### 3. Assets are registered on the plugin; the token contract is the engine's

ADR-0013 decision 3's `assets` layer lands, for themes and icon sets:
`plugin.assets.themes.<name>` and `plugin.assets.icons.<name>`, namespaced
by the engine to `<plugin>.<name>`. Icon assets flow into the `IconTable`
merge the SVG backend already performs; theme assets are the object the
selector resolves to.

A theme asset is a value of the engine's token contract, declared ONCE as a
Zod schema in `facet-engine` (`themeTokensSchema`) and consumed by
canvas-render through `z.infer`:

```
ink          'clean' | 'sketch'
fontFamily?  string                       — a family NAME; ADR-0011/0012 supply the face
glow?        { radiusPx: number }
palette      { light: PaletteTokens, dark: PaletteTokens }   — hex strings, never oklch
defaults     { nodeShape?: ShapeId, edgeRouting?: EdgeRoutingStyle, groupFrame?: FrameStyle }
```

canvas-render maps `PaletteTokens` onto its own `SpatialPalette` and hands it
to `createSpatialTheme({ mode, palette })` — the existing, unused swap point,
finally with a caller. canvas-render takes a runtime dependency on
`facet-engine` for the schema; it is zod-only and runs unchanged on Node, the
browser and a worker, so it meets the shared-layer criterion.

Putting the contract in the engine is what makes this design a PREFIX of
ADR-0013 decision 8 rather than a detour from it. Decision 8's remaining
machinery — a kind catalog with per-kind resolved-value types, plugin `views`,
per-slot resolution, and a canvas-side home for the persisted selector (the
`view` core field is markdown-only and read by nothing) — is not built here.
The recorded trigger for building it is **the first case of two plugins
offering candidates for the same slot on the same object** (an infrastructure
plugin's semantic resource facet and `visual.symbol` both wanting the badge).
When it lands, the token type does not move, the asset does not move, and the
selector migrates from this facet's payload to the engine's slot storage
under a v0 read-compat rule.

### 4. The cascade: a theme is defaults; an explicit facet wins

A theme decides HOW the canvas is drawn (ink, palette, font, glow, paper)
and may supply DEFAULTS for WHAT is drawn (`defaults.nodeShape`,
`defaults.edgeRouting`, `defaults.groupFrame`). An explicit facet on the
object — `visual.shape` on a node, `visual.edges` on the canvas — always
wins over the theme's default. A theme never moves an edge's waypoints,
never overrides a silhouette somebody chose, and never changes which symbol
a node shows. The stylesheet-versus-inline reading of "override" is the one
adopted; a theme that beats explicit settings is a lock feature, not a theme,
and is not designed here.

| existing facet | stays authoritative for | what the theme touches |
|---|---|---|
| `visual.shape` (node) | which silhouette | how it is inked — all four drawings: rect, ellipse, polygon, and the cylinder's two-element body and lid |
| `visual.edges` (canvas) | routing, line jumps | the ink of the routed path, rounded corners included; waypoints and jumps are unchanged so hit-testing, label anchors and bounds keep reading them |
| `visual.symbol` | which symbol | stroke colour from the palette; glow on the `<use>` |
| `visual.text` | placement | nothing |
| JSON Canvas `color` | preset number or hex | the six presets' actual colours come from the palette; a raw hex passes through untouched, as today |

The editor's preset swatches (`color-row.tsx`) must read the DOCUMENT's
resolved palette rather than the module constant chosen by UI mode, or the
picker shows colours the canvas will not draw.

### 5. Resolution is pulled per canvas inside layout, so an embed keeps its own theme

The theme is resolved inside `layoutSpatialCanvas` from the canvas being laid
out, at the same site `resolveCanvasEdgeStyle` is called — never passed as a
layout option and spread downward through `...options`, which is the shape
that already lets an outer document's `comments` win over an embedded
canvas's own. An embedded canvas draws in its OWN `visual.theme`; when it has
none, it inherits the host's resolved theme; a top-level canvas with none is
`clean`. This is the same precedence ADR-0013 decision 8 gives a slot
(override → persisted default → fallback) and the same side of the line
`visual.edges` and `visual.shape` already stand on in an embed.

### 6. One `style` argument is both decision #10's opt-in and decision 8's session override

Every render entry point — `layoutSpatialCanvas`, `wb_scene_render`, the
export routes, `CanvasViewer` and the MCP Apps widget, the editor's render
options — takes `style: 'clean' | 'document' | '<theme id>'`:

- headless surfaces default to `'clean'` (decision #10: an agent reading the
  SVG must never pay for jittered geometry it did not ask for);
- the editor defaults to `'document'`, drawing what the document says;
- a theme id renders that theme WITHOUT saving it — the in-memory session
  override ADR-0013 decision 8 describes, and the way a person previews a
  theme before choosing it.

The render broker's cache key (ADR-0027) gains this axis beside `theme`
(mode); a document-borne style changes the bytes for a given document and
state, so it must be in the key.

**Addendum (2026-09-11): the session override has no UI.** The editor's
Display panel carried a **Draw as** row that set it — `As saved` / `Clean` /
a preview per registered theme — and it is removed. Not a reversal of this
decision: `style` still reaches every render entry point above, headless
callers still default to `'clean'`, and the editor still defaults to
`'document'`. What is gone is the row and its wiring down through
`DocumentPage` → `SpatialEditorPane` → `SpatialEditor` → `useWorkerScene`
and the drag layers, which existed for nothing else.

The reason is the one this ADR cannot see from the render side: the row was
the Display panel's widest and the only one that could not be DRAWN. Every
other row picks a value a glyph can show; `Preview neon` and `neon` differ
by whether the pick is SAVED, and no picture says that. Previewing a theme
before choosing it is what the Theme row already does — the canvas redraws
on the pick and `Default` undoes it — so the override bought a second way to
do the same thing at the cost of the panel's one unpicturable control.

Anything that wants the argument back has it: it was never removed from the
render composition, only from the chrome. A future surface that genuinely
needs an unsaved look (a side-by-side compare, say) passes it at the render
entry point rather than threading a prop back through the editor.

### 7. Geometry: decision #10, restated as binding for this increment

- One pure decomposition per primitive in `layout/` — rect, ellipse,
  polygon, cylinder, routed edge path — from semantic geometry to an ink
  stroke set, consumed by the SVG backend AND by every hit, highlight and
  preview consumer (the `edge-rounding.ts`/`edge-flatten.ts` precedent).
- Jitter is seeded from stable node and edge identity through
  `layout/seed.ts`; a canvas renders byte-identically twice, and a translate
  or scale does not reshuffle it.
- `sceneBounds`, hit-testing, `sceneDigest`, translate and scale keep
  reading the semantic bbox and path. Ink may leave them by at most a
  DECLARED constant per style, added to bounds the way `ARROW_LENGTH` and
  `TEXT_HALO_PAD_PX` already are; sketch jitter leaves the polyline's convex
  hull, so the constant is not optional.
- The selection rectangle keeps tracing the bbox, not the wobble — accepted.

### 8. Glow is an SVG filter with a scene-sized region

The element table gains `feGaussianBlur`, `feMerge`, `feMergeNode`, and
`filter` moves from `rect`-only into the shared paint attributes so a path,
polyline, polygon, ellipse, text run and `<use>` can carry it. Filter defs are
declared at the point of use and hoisted by `collectDefs` like the drop
shadow, one def per glow colour with a content-derived id. The region is
`filterUnits="userSpaceOnUse"` sized to the scene bounds plus the glow
radius — the measured requirement above, without which every horizontal and
vertical edge disappears. The glow's reach is the style's declared bounds
constant. A resting glow is soft; a stronger glow on selection is editor
chrome and is not part of the theme.

### 9. Fonts: a theme names a family and nothing more

`fontFamily` is a family name. Whether a face for it exists on a surface is
ADR-0011's provider question and ADR-0012's install path, and a missing face
is a declared degradation per surface, never silence. Which handwriting family
ships, and how Japanese text falls back when the family lacks the script, are
decided there (ADR-0011's script-package model), not here.

### 10. What is deliberately NOT decided

- An infrastructure-diagram plugin will have two ways to put an icon on a
  node (a semantic resource facet and `visual.symbol`). That plugin decides
  it; this design does not depend on the answer and must not be shaped by it.
- Token overrides in the payload (`{ theme, overrides }`) — not in v0; v0
  may change shape without a version bump (ADR-0013 decision 2).
- Per-node style facets (Excalidraw's per-element roughness/dash) — a later
  layer of explicit facets that would win over the theme by decision 4.

## Consequences

- A theme is one word to a person and one word to an agent, stored on the
  document, visible to every collaborator and every output that asks for it.
- Adding a theme is registering an asset: no renderer change, no UI change.
  Adding an axis (a new `ink` value, a new default) is an engine-contract
  change, which is the deliberate friction ADR-0013 wants.
- `wb_facet_set` must learn a `canvas` target, and the `canvasSettings`
  contribution point must gain a derived-form vessel; both are gaps this
  design exposes rather than creates, and both land with it.
- New production files in canvas-render trip `mutation-lane-coverage.test.ts`
  by design; `spatial-geometry-parity.test.ts` gains a style axis because a
  handwriting family legitimately changes geometry; new pixel goldens cover
  what a byte golden cannot (a jitter in the wrong direction). Unstyled
  output stays byte-identical, so the three string goldens do not move.
- Every theme carries two palettes, so contrast tests run over both halves
  of every asset.
- The increment is a dependency-ordered stack (`stacking-pull-requests`):
  facet-engine (tokens, assets) and canvas-render (ink decomposition, glow,
  in-layout resolution, `style`) → plugin-visual (the facet, `sketch` and
  `neon`) → server-core/mcp-server (`wb_facet_set` canvas target, `style` on
  the render tool and export routes, the broker key) → apps/web and
  canvas-viewer (the settings vessel, worker request and cache key, palette-
  aware swatches, viewer/widget opt-in).

## Alternatives considered

- **A user preference, like dark mode.** Rejected by decision #10 before this
  ADR: two collaborators would see two documents. Survives only as the
  unsaved session override of decision 6.
- **A render-call argument alone, nothing stored.** The opt-in half without
  the document half; nobody else sees the look. Kept as decision 6, not as
  the whole.
- **A raw `x-whiteboard.theme` field**, like the old `edgeRouting`. The
  direction is the reverse: `edgeRouting` became `visual.edges/v0` with a
  legacy fallback, and the canvas extension's own comment says the
  preferences fold into `facets`.
- **Axes as the payload** (`{ ink, palette, font }`). Free combination for
  the price of a combinatorial test surface and a payload that carries raw
  style, which ADR-0013 decision 8 forbids. Axes are the IMPLEMENTATION; the
  asset bundles them.
- **A separate `theme` plugin depending on `visual`.** Weighed in decision 2;
  buys a namespace now and costs registry edits, a second settings tab, and
  plugin-dependency semantics the engine does not have.
- **Building ADR-0013 decision 8 now.** Weighed in decision 3: two design
  questions the ADR does not answer (a canvas-side selector home, per-kind
  resolved-value types), a migration of four working facet resolutions into
  views, and a slot concept in the settings UI — all for one slot with one
  candidate. Deferred to its trigger.
- **The theme owning the paper** (neon forcing a dark canvas area inside a
  light UI). Rejected in the hearing: the paper follows the UI, so every
  asset carries both palettes.
- **A scene→scene style transform.** Decision #8 rejected it for dark mode
  and decision #10 for style: paint-only passes duplicate per-type knowledge,
  and a geometry-bearing style needs shared decomposition at the consumption
  points, not a pass.
- **archify's CSS-class SVG** (semantic classes resolved by CSS variables,
  `filter: drop-shadow` from a stylesheet). Would vanish from
  `wb_scene_render`, PNG export and the widget; ADR-0013 decision 8 already
  requires canvas kinds to render as self-contained SVG.
