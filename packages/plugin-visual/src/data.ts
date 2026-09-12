import type { FacetRegistry, IconAsset } from '@kamiazya/whiteboard-facet-engine'
import {
  createFacetRegistry,
  defineFacet,
  definePlugin,
  namespacedIdSchema,
} from '@kamiazya/whiteboard-facet-engine'
import type {
  CanvasEdge,
  EdgeRoutingStyle,
  ExtensionFacets,
  LineJumps,
  SpatialCanvas,
} from '@kamiazya/whiteboard-model'
import {
  type edgeRoutingSchema,
  edgeRoutingStyleSchema,
  integerSchema,
  lineJumpsSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import {
  EDGE_ROUTING_OPTIONS,
  LINE_JUMP_OPTIONS,
  SYMBOL_CATALOG,
  SYMBOL_PICKER_OPTIONS,
} from './editors.js'
import { CATEGORY_GLYPHS } from './icons/category-glyphs.js'
import { EDGE_GLYPHS } from './icons/edge-glyphs.js'
import { BUILT_IN_ICON_NAMES, LUCIDE_ICONS } from './icons/icons.js'
import { SIGNATURE_GEOMETRY, SIGNATURE_VIEWBOX } from './icons/signature.js'
import { visualStencilsFacetSchema } from './stencil-library.js'
import { VISUAL_STENCILS } from './stencils.js'
import { VISUAL_THEMES } from './themes.js'

/**
 * `visual.edges/v0` — how this canvas's edges are drawn: the routing and
 * whether crossings jump. One facet with two fields, not two facets, since
 * both answer the same question. `v0`: unstable, payload may still change
 * shape.
 */
export const visualEdgesFacetSchema = z.object({
  routing: edgeRoutingStyleSchema.optional(),
  lineJumps: lineJumpsSchema.optional(),
})

export type VisualEdgesFacet = z.infer<typeof visualEdgesFacetSchema>

export const VISUAL_EDGES_KEY = 'visual.edges/v0'

/**
 * A ceiling rather than an unbounded list: every bend is drawn on every
 * frame of a drag, and a document is written by agents as well as people. It
 * is deliberately far above what a person places by hand — what it stops is
 * a generated payload nobody meant.
 */
const MAX_WAYPOINTS = 64

/**
 * `visual.path/v0` — where an edge BENDS, in canvas coordinates.
 *
 * A separate facet from `visual.edges/v0` rather than a field on it, because
 * the two answer different questions: `edges` picks between routings that
 * COMPUTE a path, and this one supplies the path. An edge carrying bends is
 * not choosing a routing at all — which is why the plugin draws it with a
 * router of its own rather than by widening the routing vocabulary.
 *
 * JSON Canvas has no waypoint, so this is exactly the kind of concept that
 * belongs on the facet side: nothing is lost when the document is read by a
 * reader that does not know this plugin — the edge draws with the built-in
 * routing again.
 *
 * The derived editor cannot express a list of points, so this facet answers
 * `unsupported` there. That is the honest signal ADR-0013's form layer is
 * built to give: bends want a drag affordance, not a form.
 */
export const visualPathFacetSchema = z.object({
  // Integers, the way every other coordinate in the model is stored: the
  // drag rounds before it writes, and a fractional anchor is the class that
  // survives one session and vanishes on the next reload.
  waypoints: z
    .array(z.object({ x: integerSchema, y: integerSchema }))
    .min(1)
    .max(MAX_WAYPOINTS),
})

export type VisualPathFacet = z.infer<typeof visualPathFacetSchema>

export const VISUAL_PATH_KEY = 'visual.path/v0'

/**
 * The bends this edge stores, or none — its own facet and nothing else, the
 * way `resolveEdgeOwnStyle` reads the routing. A payload the schema refuses
 * answers with none, so a malformed write draws the built-in route rather
 * than half a path.
 */
export function resolveEdgeWaypoints(
  edge: CanvasEdge,
  registry: FacetRegistry = bundledFacetRegistry,
): readonly { readonly x: number; readonly y: number }[] {
  const stored = edge['x-whiteboard']?.facets?.[VISUAL_PATH_KEY]
  if (stored === undefined) return []
  const resolution = registry.resolveFacetPayload(VISUAL_PATH_KEY, stored)
  if (resolution.kind !== 'resolved') return []
  // Re-parse rather than cast: the registry resolved through this very
  // schema, so this cannot fail — but it keeps the type honest.
  return visualPathFacetSchema.parse(resolution.value).waypoints
}

/**
 * `visual.shape/v0` — what silhouette this node draws. The vocabulary
 * matches canvas-render's outline decomposition (its absent value is the
 * historic rect, deliberately unrepresentable here too — removing the facet
 * IS choosing rect). canvas-render asserts the alignment in its own tests,
 * since this package cannot depend on it.
 */
export const visualShapeFacetSchema = z.object({
  kind: z.enum(['ellipse', 'diamond', 'hexagon', 'parallelogram', 'cylinder']),
})

export type VisualShapeFacet = z.infer<typeof visualShapeFacetSchema>

export const VISUAL_SHAPE_KEY = 'visual.shape/v0'

/**
 * A node's badge: a named icon from the renderer's vendored set, or a
 * single emoji/character. A union on purpose — the two arms render through
 * different scene nodes (icon geometry vs a text glyph) and future arms
 * (an image symbol, say) extend the union rather than overloading one
 * field. An icon NAME is validated only for non-emptiness here: the vendored
 * set is canvas-render's, and this package cannot depend on it — a name the
 * renderer does not carry degrades to no badge at draw time.
 */
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * ONE grapheme cluster — what "a badge" means. A cluster may be many code
 * points (a variation selector, a ZWJ family, a flag pair), which is why
 * this counts graphemes rather than length. Deliberately NOT emoji-only:
 * the scene node this draws through names a CJK character or a dingbat as
 * intended badge content, and a facet must not be narrower than the
 * substrate that renders it.
 */
const isSingleGrapheme = (value: string): boolean => [...graphemes.segment(value)].length === 1

export const visualSymbolFacetSchema = z.union([
  z.object({ kind: z.literal('icon'), name: z.string().min(1) }),
  z.object({
    kind: z.literal('emoji'),
    char: z
      .string()
      .min(1)
      .refine(isSingleGrapheme, 'must be a single character or emoji, not a string'),
  }),
])

export type VisualSymbolFacet = z.infer<typeof visualSymbolFacetSchema>

export const VISUAL_SYMBOL_KEY = 'visual.symbol/v0'

/**
 * Where a node's text sits inside the space it has. Separate from
 * `visual.shape` on purpose: a plain rect may want centred text, and a
 * shaped node may want its text at the top — tying placement to the
 * silhouette would make one choice unreachable from the other.
 *
 * ABSENT means "however this node would place text anyway" (a shaped node
 * centres what fits, a rect starts at the top). The facet overrides that
 * default; it does not restate it, which is why there is no third value.
 */
export const visualTextFacetSchema = z.object({
  align: z.enum(['start', 'center']),
})

export type VisualTextFacet = z.infer<typeof visualTextFacetSchema>

export const VISUAL_TEXT_KEY = 'visual.text/v0'

/**
 * `visual.theme/v0` — how this canvas is DRAWN, as the id of a registered
 * theme asset (ADR-0030 decision 2): `visual.sketch`, `visual.neon`, or a
 * theme another plugin registers. The payload never carries raw styles; the
 * asset supplies the tokens, and the registry refuses an id nobody
 * registered at write time. ABSENT is the bundled look, which is why the
 * picker's first segment is `null` rather than a stored `'default'`.
 */
export const visualThemeFacetSchema = z.object({
  theme: namespacedIdSchema,
})

export type VisualThemeFacet = z.infer<typeof visualThemeFacetSchema>

export const VISUAL_THEME_KEY = 'visual.theme/v0'

/**
 * `visual.stencil/v0` — which registered STENCIL this node wears
 * ([ADR-0034](../../../docs/contributing/adr/0034-stencil-and-recipe.md)
 * decision 5), by id. The payload carries NO appearance: applying a stencil
 * expands its colour and facets onto the node itself, and this records where
 * they came from.
 *
 * The record is what makes a dressed board legible rather than merely
 * decorated. ADR-0033 scores the distinctions a drawing SHOWS against the
 * ones its document DECLARES, and a stencil id is a declaration — so a board
 * dressed by kind reads as carrying its constructs. Without it the identical
 * drawing reads as `excess`, and the axis scores a real improvement as a
 * defect.
 *
 * `assetRefs` does the same job it does for a theme: a write naming a
 * stencil nobody registered is refused, with the registered ids listed.
 */
export const visualStencilFacetSchema = z.object({
  stencil: namespacedIdSchema,
})

export type VisualStencilFacet = z.infer<typeof visualStencilFacetSchema>

/**
 * The vendored geometry as registered assets, keyed by bare name — the
 * registry composes `visual.<name>`, the way it does for themes.
 *
 * `iconAssetSchema` parses these at `definePlugin` time, so a malformed
 * entry stops the plugin rather than reaching a picker. The spread is what
 * the schema's inferred (mutable) array wants; the source table stays
 * readonly.
 */
const VISUAL_ICON_ASSETS: Readonly<Record<string, IconAsset>> = Object.fromEntries(
  [
    ...BUILT_IN_ICON_NAMES.map((name) => [name, LUCIDE_ICONS[name] ?? []] as const),
    // Beside the vendored set, not inside it: `BUILT_IN_ICON_NAMES` is what
    // a NODE may wear as a badge, and the symbol picker derives its options
    // from that list. A picture of a routing style is not a badge, so it is
    // registered geometry without being a symbol anyone can choose. Nor is
    // a picture of an emoji CATEGORY — that one is chrome, drawn in the
    // panel's own stroke language so the row that browses does not read as
    // a spilled sample of what it browses.
    ...Object.entries(EDGE_GLYPHS),
    ...Object.entries(CATEGORY_GLYPHS),
  ].map(([name, geometry]) => [name, { geometry: [...geometry] }]),
)

/**
 * Everything above shares the lucide 24-grid; the signature does not, so it
 * is registered separately with its own box rather than squeezed into one
 * the path was never drawn for.
 */
const VISUAL_ASSET_ICONS: Readonly<Record<string, IconAsset>> = {
  ...VISUAL_ICON_ASSETS,
  signature: { viewBox: SIGNATURE_VIEWBOX, geometry: [...SIGNATURE_GEOMETRY] },
}

/**
 * The bundled plugin. Deliberately ordinary (ADR-0013 decision 3): it goes
 * through the same registry, validation and ordering as any deployment's
 * added plugins, and a deployment may disable it.
 */
export const visualPlugin = definePlugin({
  id: 'visual',
  displayName: 'Visual style',
  facets: [
    defineFacet({
      name: 'edges',
      displayName: 'Edges',
      version: 'v0',
      // Both scopes, one facet: the question ("how is this drawn") is the
      // same asked of a canvas and of one edge, and ADR-0013 decision 1's
      // growth rule says that is one facet, not two. `visual.symbol` was
      // widened the same way. The key stays `v0`: `targets` declares where a
      // payload may attach and is not itself payload, so no stored value
      // changes meaning and there is no migration to write.
      targets: ['canvas', 'edge'],
      schema: visualEdgesFacetSchema,
      // FIELDS, not a picker: the two axes are independent — a person
      // changing the routing is not restating the jumps — so a control
      // writing whole payloads would make every pick a statement about
      // both. The labels and glyphs live here so the vessel drawing this
      // row names neither; it reads the declaration like any other.
      editor: {
        fields: {
          // CARDS: three named routings and an on/off, whose words carry
          // meaning the line alone does not — a curve is a curve, but which
          // of them the board is FOLLOWING is a word. Same shape Settings
          // gives theme and tab icon.
          routing: {
            widget: 'segmented',
            label: 'Edge routing',
            options: EDGE_ROUTING_OPTIONS,
            layout: 'cards',
          },
          lineJumps: {
            widget: 'segmented',
            label: 'Line jumps',
            options: LINE_JUMP_OPTIONS,
            layout: 'cards',
          },
        },
      },
    }),
    defineFacet({
      name: 'path',
      displayName: 'Bends',
      version: 'v0',
      // Edges only: a bend is a property of ONE line. The canvas-wide
      // question ("how are edges drawn here") is `visual.edges`, and a
      // board-wide list of points would mean nothing.
      targets: ['edge'],
      schema: visualPathFacetSchema,
    }),
    defineFacet({
      name: 'shape',
      displayName: 'Shape',
      version: 'v0',
      targets: ['node'],
      schema: visualShapeFacetSchema,
      // Declared, not hand-written: the bundled plugin goes through the
      // same catalog a third-party plugin would, so the mechanism is
      // exercised by its first customer. `null` is the Rectangle option —
      // rect is the ABSENT facet, not a stored value.
      editor: {
        picker: {
          options: [
            { payload: null, label: 'Rectangle', glyph: { kind: 'shape', name: 'square' } },
            {
              payload: { kind: 'ellipse' },
              label: 'Ellipse',
              glyph: { kind: 'shape', name: 'circle' },
            },
            {
              payload: { kind: 'diamond' },
              label: 'Diamond',
              glyph: { kind: 'shape', name: 'diamond' },
            },
            {
              payload: { kind: 'hexagon' },
              label: 'Hexagon',
              glyph: { kind: 'shape', name: 'hexagon' },
            },
            {
              payload: { kind: 'parallelogram' },
              label: 'Parallelogram',
              glyph: { kind: 'shape', name: 'parallelogram' },
            },
            {
              payload: { kind: 'cylinder' },
              label: 'Cylinder',
              glyph: { kind: 'shape', name: 'cylinder' },
            },
          ],
        },
      },
    }),
    defineFacet({
      name: 'text',
      displayName: 'Text placement',
      version: 'v0',
      targets: ['node'],
      schema: visualTextFacetSchema,
      editor: {
        picker: {
          options: [
            {
              payload: null,
              label: 'Default placement',
              glyph: { kind: 'shape', name: 'none' },
            },
            { payload: { align: 'start' }, label: 'Top' },
            { payload: { align: 'center' }, label: 'Middle' },
          ],
        },
      },
    }),
    defineFacet({
      name: 'theme',
      displayName: 'Theme',
      version: 'v0',
      targets: ['canvas'],
      schema: visualThemeFacetSchema,
      assetRefs: { theme: 'themes' },
      editor: {
        picker: {
          // CARDS: a look has a NAME a person says out loud, and three cells
          // give the specimen room to be seen. A chip-sized swatch of the
          // same mark reads as a smudge.
          layout: 'cards',
          // The SAME mark three times, drawn three ways: plain for the
          // bundled look, and once per theme through that theme's own
          // `ink` and `glow`. So registering a theme needs no new SWATCH —
          // the picture follows from the tokens the asset already carries,
          // which is what ADR-0030 decision 2 promises.
          //
          // The OPTION LIST is still written out here, and that is a real
          // gap rather than the promise: a deployment registering a third
          // theme gets a picker that does not offer it, exactly as stencils
          // did before `assetRefs` drove their options. This picker takes a
          // different road — cards carrying a per-option GLYPH spec, not the
          // plain `fields`/`segmented` shape the registry now fills — so
          // closing it means deciding what glyph a theme nobody wrote a
          // spec for should draw. Named so the next reader finds it rather
          // than trusting the sentence above.
          options: [
            {
              payload: null,
              label: 'Default',
              glyph: { kind: 'asset', id: 'visual.signature' },
            },
            {
              payload: { theme: 'visual.sketch' },
              label: 'Sketch',
              glyph: { kind: 'theme', id: 'visual.sketch', icon: 'visual.signature' },
            },
            {
              payload: { theme: 'visual.neon' },
              label: 'Neon',
              glyph: { kind: 'theme', id: 'visual.neon', icon: 'visual.signature' },
            },
          ],
        },
      },
    }),
    defineFacet({
      name: 'symbol',
      displayName: 'Symbol',
      version: 'v0',
      // All three: a symbol answers "what symbolises this object", and the
      // object may be a node, a spatial document's canvas, or a markdown
      // document. Widening `targets` is a change to WHERE a payload may
      // attach, never to the payload — so the version does not move.
      targets: ['node', 'canvas', 'document'],
      schema: visualSymbolFacetSchema,
      // The facet that broke the ladder, now declared like the rest — and
      // the one that then broke it a second way.
      //
      // Its choices straddle both schema arms, which a field-level control
      // cannot express, so this facet had a hand-written React component
      // and a hand-written component has no styling contract. The picker
      // writes whole payloads, so the arms stop mattering, and the icon
      // options name REGISTERED GEOMETRY rather than shipping a drawing.
      //
      // What that still could not say was "and anything else": a listed
      // option is a listed option, so the emoji arm — open by schema since
      // day one — was five characters wide. The catalog and its free entry
      // are the vocabulary widened again rather than the escape hatch
      // reopened.
      editor: { picker: { options: SYMBOL_PICKER_OPTIONS, catalog: SYMBOL_CATALOG } },
    }),
    defineFacet({
      name: 'stencil',
      displayName: 'Stencil',
      version: 'v0',
      // A node only. A stencil dresses ONE box; a canvas-wide appearance is
      // what `visual.theme` already is, and the two answer different
      // questions — a theme says how the whole board is drawn, a stencil
      // says what one box IS.
      targets: ['node'],
      schema: visualStencilFacetSchema,
      assetRefs: { stencil: 'stencils' },
      // A PICKER, declared, rather than the text box the derived form would
      // give a regex-validated string. Caught by `facet-panel.browser.test`
      // the first time this facet shipped without it: the panel offered a
      // free-entry field and a Save button for a value that must name a
      // registered asset, so the one id a user could type by hand was a
      // wrong one.
      //
      // The WIDGET is declared and the OPTIONS are not: `assetRefs` above
      // says this field names a stencil, and the registry fills the choices
      // from what it actually holds. That is what makes a pack this repo did
      // not ship SELECTABLE and not merely applicable — the state it shipped
      // in first, where `wb_facet_list` reported a stencil, `wb_canvas_edit`
      // applied it, and the panel did not offer it.
      editor: { fields: { stencil: { widget: 'segmented', label: 'Stencil' } } },
    }),
    defineFacet({
      name: 'stencils',
      displayName: 'Stencil library',
      version: 'v0',
      // A DOCUMENT only, and the singular/plural pair is the distinction:
      // `visual.stencil` says which stencil one box WEARS, `visual.stencils`
      // says which stencils a document DEFINES. One is worn, the other is
      // drawn from.
      targets: ['document'],
      schema: visualStencilsFacetSchema,
      // No `editor`, so the derived form answers `unsupported` — a record of
      // records is outside the control vocabulary, and that is the honest
      // signal rather than a half-rendered payload. The affordance for
      // growing a vocabulary is editing the document, which is the whole
      // reason a library is one.
    }),
  ],
  // The vendored set, registered as ADR-0013 decision 3 assets so a
  // declared picker — and any other realm holding the registry — can draw
  // it from data. The kind existed and no plugin used it; the symbol
  // picker is its first customer, and the reason the escape hatch is no
  // longer needed.
  assets: { themes: VISUAL_THEMES, icons: VISUAL_ASSET_ICONS, stencils: VISUAL_STENCILS },
})

export const bundledPlugins = [visualPlugin]

/**
 * The registry every composition uses unless a deployment configures its
 * own plugin set. A shared instance, not a per-call construction: the
 * registry is immutable data.
 *
 * ponytail: the bundled SET is a composition answer, not this plugin's, and
 * it lives here only because this plugin is currently the whole set. Give it
 * its own home the moment a second bundled plugin exists — not before, since
 * a package holding one array buys a reviewer nothing.
 */
export const bundledFacetRegistry = createFacetRegistry(bundledPlugins)

export type EdgeRouting = z.infer<typeof edgeRoutingSchema>

/**
 * The one read path for "how do I route this canvas's edges": the
 * `visual.edges/v0` facet when it resolves, else nothing — the defaults are
 * `resolveCanvasEdgeDefaults`'s. A facet is one register (replace
 * semantics), so a facet that says only `routing` means "and default line
 * jumps".
 */
export function resolveCanvasEdgeStyle(
  canvas: SpatialCanvas,
  registry: FacetRegistry = bundledFacetRegistry,
): EdgeRouting {
  const extension = canvas['x-whiteboard']
  const stored = extension?.facets?.[VISUAL_EDGES_KEY]
  if (stored !== undefined) {
    const resolution = registry.resolveFacetPayload(VISUAL_EDGES_KEY, stored)
    if (resolution.kind === 'resolved') {
      // Re-parse instead of casting: the registry resolved through this very
      // schema, so this cannot fail — but it keeps the type honest.
      const value = visualEdgesFacetSchema.parse(resolution.value)
      return {
        ...(value.routing === undefined ? {} : { style: value.routing }),
        ...(value.lineJumps === undefined ? {} : { lineJumps: value.lineJumps }),
      }
    }
  }
  return {}
}

/**
 * What this canvas's edges default to where its facet is silent: the theme
 * it names (ADR-0030 decision 4 — a theme's `edgeRouting` fills in only
 * where `visual.edges` says nothing), else the built-in straight line, and
 * never a jump. A theme the registry does not carry defaults like none, the
 * way the renderer degrades on it.
 *
 * The write path canonicalises against THIS, not against the built-in: a
 * choice equal to the canvas's default leaves no trace, and a choice that
 * differs from it is recorded even when it is the built-in default. Judged
 * against the built-in alone, choosing Straight on an orthogonal-by-theme
 * board deleted the facet, and the theme drew orthogonal anyway.
 */
export function resolveCanvasEdgeDefaults(
  canvas: SpatialCanvas,
  registry: FacetRegistry = bundledFacetRegistry,
): { readonly style: EdgeRoutingStyle; readonly lineJumps: LineJumps } {
  const themeId = resolveCanvasTheme(canvas, registry)
  const themed = themeId === undefined ? undefined : registry.themeAsset(themeId)
  const routing = edgeRoutingStyleSchema.safeParse(themed?.defaults.edgeRouting)
  return { style: routing.success ? routing.data : 'straight', lineJumps: 'none' }
}

/** The routing and jumps this canvas draws with under its own theme: the explicit facet, field by field, over `resolveCanvasEdgeDefaults`. */
export function resolveEffectiveCanvasEdgeStyle(
  canvas: SpatialCanvas,
  registry: FacetRegistry = bundledFacetRegistry,
): { readonly style: EdgeRoutingStyle; readonly lineJumps: LineJumps } {
  const explicit = resolveCanvasEdgeStyle(canvas, registry)
  const defaults = resolveCanvasEdgeDefaults(canvas, registry)
  return {
    style: explicit.style ?? defaults.style,
    lineJumps: explicit.lineJumps ?? defaults.lineJumps,
  }
}

/**
 * How ONE edge is drawn: its own `visual.edges/v0` facet field by field over
 * the canvas's answer, over the theme's default, over the built-in.
 *
 * Field by field rather than whole-value, and deliberately unlike the
 * canvas-vs-nothing case: the two payloads are at DIFFERENT scopes, so an
 * edge saying only `routing` is narrowing that one field, not declaring that
 * the board's line jumps do not apply to it. Whole-value replacement is the
 * rule WITHIN one scope, where a facet is one register.
 */
export function resolveEdgeStyle(
  canvas: SpatialCanvas,
  edge: CanvasEdge,
  registry: FacetRegistry = bundledFacetRegistry,
): { readonly style: EdgeRoutingStyle; readonly lineJumps: LineJumps } {
  const own = resolveEdgeOwnStyle(edge, registry)
  const canvasWide = resolveEffectiveCanvasEdgeStyle(canvas, registry)
  return {
    style: own.routing ?? canvasWide.style,
    lineJumps: own.lineJumps ?? canvasWide.lineJumps,
  }
}

/**
 * What an edge says about ITSELF, with no canvas or theme filled in — the
 * stored facet and nothing else. Separate from `resolveEdgeStyle` because an
 * editor showing "inherited unless overridden" needs to know which fields
 * the edge actually holds, and a resolved value cannot say.
 */
export function resolveEdgeOwnStyle(
  edge: CanvasEdge,
  registry: FacetRegistry = bundledFacetRegistry,
): VisualEdgesFacet {
  const stored = edge['x-whiteboard']?.facets?.[VISUAL_EDGES_KEY]
  if (stored === undefined) return {}
  const resolution = registry.resolveFacetPayload(VISUAL_EDGES_KEY, stored)
  if (resolution.kind !== 'resolved') return {}
  return visualEdgesFacetSchema.parse(resolution.value)
}

/**
 * The one read path for "which theme does this canvas name": the
 * `visual.theme/v0` facet when it resolves, else undefined — the bundled
 * look. Answers the ID only; whether the id resolves to an asset is the
 * renderer's question, and an id this deployment does not carry degrades
 * there, never here.
 */
export function resolveCanvasTheme(
  canvas: SpatialCanvas,
  registry: FacetRegistry = bundledFacetRegistry,
): string | undefined {
  const stored = canvas['x-whiteboard']?.facets?.[VISUAL_THEME_KEY]
  if (stored === undefined) return undefined
  const resolution = registry.resolveFacetPayload(VISUAL_THEME_KEY, stored)
  if (resolution.kind !== 'resolved') return undefined
  return visualThemeFacetSchema.parse(resolution.value).theme
}

/**
 * The one read path for "what silhouette does this node draw": the
 * `visual.shape/v0` facet when it resolves, else undefined — which every
 * consumer already treats as the historic rect.
 */
export function resolveNodeShape(
  node: SpatialCanvas['nodes'][number],
  registry: FacetRegistry = bundledFacetRegistry,
): VisualShapeFacet['kind'] | undefined {
  const stored = node['x-whiteboard']?.facets?.[VISUAL_SHAPE_KEY]
  if (stored === undefined) return undefined
  const resolution = registry.resolveFacetPayload(VISUAL_SHAPE_KEY, stored)
  if (resolution.kind !== 'resolved') return undefined
  return visualShapeFacetSchema.parse(resolution.value).kind
}

/**
 * The one read path for "what symbol does this object wear", over the facets
 * bucket the object stores. Every surface that draws a symbol — the node
 * badge, the minimap, the favicon, a file row — goes through here, so an
 * unresolvable payload means the same thing everywhere: no symbol, never a
 * different fallback per surface. An unknown icon NAME still resolves here
 * (the schema only checks non-emptiness) and degrades where it is drawn.
 */
function readSymbol(
  facets: ExtensionFacets | undefined,
  registry: FacetRegistry,
): VisualSymbolFacet | undefined {
  const stored = facets?.[VISUAL_SYMBOL_KEY]
  if (stored === undefined) return undefined
  const resolution = registry.resolveFacetPayload(VISUAL_SYMBOL_KEY, stored)
  if (resolution.kind !== 'resolved') return undefined
  // Re-parse rather than cast: the registry resolved through this very
  // schema, so this cannot fail — it keeps the type honest, and a throw
  // here would mean the registry and this schema had come apart.
  return visualSymbolFacetSchema.parse(resolution.value)
}

/** The badge a NODE wears. */
export function resolveNodeSymbol(
  node: SpatialCanvas['nodes'][number],
  registry: FacetRegistry = bundledFacetRegistry,
): VisualSymbolFacet | undefined {
  return readSymbol(node['x-whiteboard']?.facets, registry)
}

/** The symbol a SPATIAL document wears, stored on its canvas envelope. */
export function resolveCanvasSymbol(
  canvas: SpatialCanvas,
  registry: FacetRegistry = bundledFacetRegistry,
): VisualSymbolFacet | undefined {
  return readSymbol(canvas['x-whiteboard']?.facets, registry)
}

/**
 * The symbol a MARKDOWN document wears, from its OKF frontmatter facets.
 * Takes the bucket rather than a document: this package cannot open stored
 * content, and every caller has already parsed the frontmatter it holds.
 */
export function resolveDocumentSymbol(
  facets: ExtensionFacets | undefined,
  registry: FacetRegistry = bundledFacetRegistry,
): VisualSymbolFacet | undefined {
  return readSymbol(facets, registry)
}

/**
 * The one read path for "where does this node's text sit": the
 * `visual.text/v0` facet when it resolves, else undefined — which every
 * consumer treats as the placement it would have chosen anyway.
 */
export function resolveNodeTextAlign(
  node: SpatialCanvas['nodes'][number],
  registry: FacetRegistry = bundledFacetRegistry,
): VisualTextFacet['align'] | undefined {
  const stored = node['x-whiteboard']?.facets?.[VISUAL_TEXT_KEY]
  if (stored === undefined) return undefined
  const resolution = registry.resolveFacetPayload(VISUAL_TEXT_KEY, stored)
  if (resolution.kind !== 'resolved') return undefined
  return visualTextFacetSchema.parse(resolution.value).align
}
