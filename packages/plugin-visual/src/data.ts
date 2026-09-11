import type {
  FacetPickerOption,
  FacetRegistry,
  FacetSegmentedOption,
  IconAsset,
} from '@kamiazya/whiteboard-facet-engine'
import {
  createFacetRegistry,
  defineFacet,
  definePlugin,
  namespacedIdSchema,
} from '@kamiazya/whiteboard-facet-engine'
import type {
  EdgeRoutingStyle,
  ExtensionFacets,
  LineJumps,
  SpatialCanvas,
} from '@kamiazya/whiteboard-model'
import {
  type edgeRoutingSchema,
  edgeRoutingStyleSchema,
  lineJumpsSchema,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { EDGE_GLYPHS } from './icons/edge-glyphs.js'
import { BUILT_IN_ICON_NAMES, LUCIDE_ICONS } from './icons/icons.js'
import { SIGNATURE_GEOMETRY, SIGNATURE_VIEWBOX } from './icons/signature.js'
import { VISUAL_THEMES } from './themes.js'

/**
 * `visual.edges/v0` — how this canvas's edges are drawn. The facet-shaped
 * successor of the legacy canvas-level `x-whiteboard.edgeRouting`
 * preference; both answer the same question, so this is one facet with two
 * fields, not two facets. `v0`: unstable, payload may still change shape.
 */
export const visualEdgesFacetSchema = z.object({
  routing: edgeRoutingStyleSchema.optional(),
  lineJumps: lineJumpsSchema.optional(),
})

export type VisualEdgesFacet = z.infer<typeof visualEdgesFacetSchema>

export const VISUAL_EDGES_KEY = 'visual.edges/v0'

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
    // registered geometry without being a symbol anyone can choose.
    ...Object.entries(EDGE_GLYPHS),
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
 * A small starter set of character symbols beside the icons. Free entry is
 * a job for a form, not a picker; what a picker owes is a set somebody can
 * choose from in one press.
 */
const SYMBOL_CHARS = ['✅', '⚠️', '🔥', '⭐', '📌'] as const

/**
 * Derived from the vendored set rather than listed, so an icon added to
 * `LUCIDE_ICONS` reaches the picker with no second edit — the drift that
 * put a name in one place and not the other cannot happen.
 */
const SYMBOL_PICKER_OPTIONS: readonly FacetPickerOption[] = [
  { payload: null, label: 'No symbol', glyph: { kind: 'shape', name: 'none' } },
  ...BUILT_IN_ICON_NAMES.map((name) => ({
    payload: { kind: 'icon' as const, name },
    label: `Icon ${name}`,
    glyph: { kind: 'asset' as const, id: `visual.${name}` },
  })),
  ...SYMBOL_CHARS.map((char) => ({
    payload: { kind: 'emoji' as const, char },
    label: `Emoji ${char}`,
    glyph: { kind: 'char' as const, value: char },
  })),
]

/**
 * `visual.edges/v0`'s two rows, as data.
 *
 * Every value here is a stored one — neither row offers `value: null`,
 * because neither axis has an "absent" a person picks. Absence means "let
 * the theme decide", and the way back to it is picking the value the theme
 * already has: the write path canonicalises a pick equal to the effective
 * default down to no stored facet, so the row returns to following the
 * theme without a separate control saying so.
 */
const EDGE_ROUTING_OPTIONS: readonly FacetSegmentedOption[] = [
  { value: 'straight', label: 'Straight', glyph: { kind: 'asset', id: 'visual.edge-straight' } },
  {
    value: 'orthogonal',
    label: 'Orthogonal',
    glyph: { kind: 'asset', id: 'visual.edge-orthogonal' },
  },
  { value: 'curved', label: 'Curved', glyph: { kind: 'asset', id: 'visual.edge-curved' } },
]

const LINE_JUMP_OPTIONS: readonly FacetSegmentedOption[] = [
  { value: 'none', label: 'Off', glyph: { kind: 'asset', id: 'visual.line-jumps-off' } },
  { value: 'arc', label: 'On', glyph: { kind: 'asset', id: 'visual.line-jumps-on' } },
]

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
      targets: ['canvas'],
      schema: visualEdgesFacetSchema,
      // FIELDS, not a picker: the two axes are independent — a person
      // changing the routing is not restating the jumps — so a control
      // writing whole payloads would make every pick a statement about
      // both. The labels and glyphs live here so the vessel drawing this
      // row names neither; it reads the declaration like any other.
      editor: {
        fields: {
          routing: {
            widget: 'segmented',
            label: 'Edge routing',
            options: EDGE_ROUTING_OPTIONS,
          },
          lineJumps: {
            widget: 'segmented',
            label: 'Line jumps',
            options: LINE_JUMP_OPTIONS,
          },
        },
      },
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
          // The SAME mark three times, drawn three ways: plain for the
          // bundled look, and once per theme through that theme's own
          // `ink` and `glow`. So registering a theme still changes nothing
          // on any UI side — the swatch follows from the tokens the asset
          // already carries, which is what ADR-0030 decision 2 promises.
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
      // The facet that broke the ladder, now declared like the rest.
      //
      // Its twelve choices straddle both schema arms, which a field-level
      // control cannot express — so this one had a hand-written React
      // component, and a hand-written component has no styling contract.
      // The picker writes whole payloads, so the arms stop mattering, and
      // the icon options name REGISTERED GEOMETRY (below) rather than
      // shipping a drawing. Both halves are what let this facet come back
      // inside the vocabulary.
      editor: { picker: { options: SYMBOL_PICKER_OPTIONS } },
    }),
  ],
  // The vendored set, registered as ADR-0013 decision 3 assets so a
  // declared picker — and any other realm holding the registry — can draw
  // it from data. The kind existed and no plugin used it; the symbol
  // picker is its first customer, and the reason the escape hatch is no
  // longer needed.
  assets: { themes: VISUAL_THEMES, icons: VISUAL_ASSET_ICONS },
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
 * `visual.edges/v0` facet when it resolves, else the legacy
 * `x-whiteboard.edgeRouting` preference. Whole-value precedence, not
 * per-field merge — a facet is one register (replace semantics), so a facet
 * that says only `routing` means "and default line jumps", never "merge
 * with whatever the legacy key held".
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
  return extension?.edgeRouting ?? {}
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
