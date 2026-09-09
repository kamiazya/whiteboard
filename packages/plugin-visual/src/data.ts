import type { FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
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
    }),
    defineFacet({
      name: 'shape',
      displayName: 'Shape',
      version: 'v0',
      targets: ['node'],
      schema: visualShapeFacetSchema,
      // Declared, not hand-written: the bundled plugin goes through the
      // same tier-2 catalog a third-party plugin would, so the mechanism
      // is exercised by its first customer. `null` is the Rectangle
      // segment — rect is the ABSENT facet, not a stored value.
      editor: {
        fields: {
          kind: {
            widget: 'segmented',
            label: 'Shape',
            quick: true,
            options: [
              { value: null, label: 'Rectangle', glyph: 'square' },
              { value: 'ellipse', label: 'Ellipse', glyph: 'circle' },
              { value: 'diamond', label: 'Diamond', glyph: 'diamond' },
              { value: 'hexagon', label: 'Hexagon', glyph: 'hexagon' },
              { value: 'parallelogram', label: 'Parallelogram', glyph: 'parallelogram' },
              { value: 'cylinder', label: 'Cylinder', glyph: 'cylinder' },
            ],
          },
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
        fields: {
          align: {
            widget: 'segmented',
            label: 'Text',
            quick: true,
            options: [
              { value: null, label: 'Default placement', glyph: 'none' },
              { value: 'start', label: 'Top' },
              { value: 'center', label: 'Middle' },
            ],
          },
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
        fields: {
          theme: {
            widget: 'segmented',
            label: 'Theme',
            quick: true,
            options: [
              { value: null, label: 'Default' },
              { value: 'visual.sketch', label: 'Sketch' },
              { value: 'visual.neon', label: 'Neon' },
            ],
          },
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
    }),
  ],
  assets: { themes: VISUAL_THEMES },
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
