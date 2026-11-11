import type { FacetRegistry, IconAsset, PluginHost } from '@kamiazya/whiteboard-facet-engine'
import {
  createFacetRegistry,
  iconAssetSchema,
  pluginFromManifest,
} from '@kamiazya/whiteboard-facet-engine'
import type {
  EdgeRoutingStyle,
  ExtensionFacets,
  LineJumps,
  SpatialCanvas,
} from '@kamiazya/whiteboard-model'
import { type edgeRoutingSchema, edgeRoutingStyleSchema } from '@kamiazya/whiteboard-model'
import type { RoutableElement } from '@kamiazya/whiteboard-scene'
import type { z } from 'zod'
import { assetTable } from './asset-table.js'
import glyphs from './assets/icons-glyphs.json' with { type: 'json' }
import { symbolCatalogLoad } from './editors.js'
import type {
  VisualEdgesFacet,
  VisualShapeFacet,
  VisualSymbolFacet,
  VisualTextFacet,
} from './generated/visual.zod.js'
import {
  visualAxesFacetSchema,
  visualEdgesFacetSchema,
  visualInkFacetSchema,
  visualShapeFacetSchema,
  visualStencilFacetSchema,
  visualSymbolFacetSchema,
  visualTextFacetSchema,
  visualThemeFacetSchema,
} from './generated/visual.zod.js'
import { LUCIDE_ASSETS } from './icons/icons.js'
import { visualStencilsFacetSchema } from './stencil-library.js'
import { VISUAL_STENCILS } from './stencils.js'
import { type StrokeWidth, VISUAL_STROKE_KEY, visualStrokeFacetSchema } from './stroke.js'
import { visualTagsFacetSchema } from './tag-library.js'
import { VISUAL_THEMES } from './themes.js'
import manifest from './visual.manifest.json' with { type: 'json' }

// The payloads of the simple facets below are generated from
// `contracts/facets/visual`; what each one MEANS stays documented here.
export type { VisualEdgesFacet, VisualShapeFacet, VisualTextFacet }

/**
 * `visual.edges/v0` — how this canvas's edges are drawn: the routing and
 * whether crossings jump. One facet with two fields, not two facets, since
 * both answer the same question. `v0`: unstable, payload may still change
 * shape.
 */
export const VISUAL_EDGES_KEY = 'visual.edges/v0'

/**
 * `visual.shape/v0` — what silhouette this node draws. The vocabulary
 * matches canvas-render's outline decomposition (its absent value is the
 * historic rect, deliberately unrepresentable here too — removing the facet
 * IS choosing rect). canvas-render asserts the alignment in its own tests,
 * since this package cannot depend on it.
 */
export { visualShapeFacetSchema }

export const VISUAL_SHAPE_KEY = 'visual.shape/v0'

/**
 * `visual.ink/v0` — which strokes are ONE thing.
 *
 * A handwritten character is several strokes and a person means one mark by
 * them: they select together, move together and are deleted together. The
 * model has no container for that — a Group is a NODE holding nodes, and a
 * stroke is a line — so the membership is written on each line instead, as
 * the id of the group it belongs to.
 *
 * An id rather than a nesting, because strokes arrive one at a time: the
 * writer of the second stroke knows which group it is joining and nothing
 * has to be rewritten. Lines sharing an id are one object; a line carrying
 * none is one object by itself, which is what ink from an import or an
 * agent's write is.
 */
export const VISUAL_INK_KEY = 'visual.ink/v0'

/**
 * `visual.axes/v0` — which of its own facets a canvas treats as SEMANTIC
 * AXES, so a reader can tell a distinction it means from a distinction it
 * merely draws.
 *
 * A board carries several at once: an infrastructure drawing wants
 * silhouette for what a component IS and colour for whether it is healthy,
 * and those are two axes competing for two channels. Without a declaration
 * the second one has nowhere to live — anything a document says about its
 * boxes beyond frame, node kind and stencil is invisible to every reader
 * that did not write it, so a colour spent on it looks like decoration.
 *
 * A LIST OF KEYS rather than "every facet is an axis", and that is the whole
 * design. `visual.shape/v0` is a facet and is emphatically not an axis — it
 * says what a box DRAWS, not what it IS — and nothing about a facet's shape
 * reveals which kind it is. Only the document knows, so the document says.
 *
 * The keys are not checked against the registry here: a canvas may name an
 * axis carried by a facet a later build registers, or one this deployment
 * disabled, and losing the whole declaration to that would cost more than
 * the stray key does. A key no box carries simply contributes no partition.
 *
 * A board declares a handful, and colour and silhouette are the only two
 * channels an axis competes for, so the write bound of 64 axes (the
 * contract's `maxItems`) is an order of magnitude over any board a reader
 * could follow. What it bounds is a payload: every layout scores the
 * declaration for the legend, and an unbounded list let one write of a few
 * megabytes cost a render tens of seconds. A stored declaration past it still
 * reads, because the scorer reads the stored payload itself and skips a key no
 * box carries.
 */
export const VISUAL_AXES_KEY = 'visual.axes/v0'

/**
 * A node's badge: a named icon from the renderer's vendored set, or a
 * single emoji/character, generated from `contracts/facets/visual`. A union
 * on purpose — the two arms render through different scene nodes (icon
 * geometry vs a text glyph) and future arms (an image symbol, say) extend the
 * union rather than overloading one field. An icon NAME is validated only for
 * non-emptiness: the vendored set is canvas-render's, and this package cannot
 * depend on it — a name the renderer does not carry degrades to no badge at
 * draw time.
 *
 * The description `wb_facet_list` serves says WHERE the badge is drawn
 * (surfaces too small to read the object, not the canvas) and names the
 * channel that does work on a board, a declared scoped tag, because the name
 * alone is the closest word in the table to "show it" and a caller acted on
 * exactly that. Its example is deliberately a word no eval task uses: a
 * description that quotes the task it is measured on measures the quote. It
 * names the LIBRARY because an undeclared tag value carries no colour, and a
 * description is a promise the product has to keep.
 */
export { type VisualSymbolFacet, visualSymbolFacetSchema }

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
export const VISUAL_TEXT_KEY = 'visual.text/v0'

/**
 * `visual.theme/v0` — how this canvas is DRAWN, as the id of a registered
 * theme asset (ADR-0030 decision 2): `visual.sketch`, `visual.neon`, or a
 * theme another plugin registers. The payload never carries raw styles; the
 * asset supplies the tokens, and the registry refuses an id nobody
 * registered at write time. ABSENT is the bundled look, which is why the
 * picker's first segment is `null` rather than a stored `'default'`.
 */
export const VISUAL_THEME_KEY = 'visual.theme/v0'

/**
 * Every registered icon, keyed by bare name — the registry composes
 * `visual.<name>`, the way it does for themes. The vendored lucide set comes
 * first, then the glyphs (`assets/icons-glyphs.json`).
 *
 * The glyphs sit beside the vendored set, not inside it: `BUILT_IN_ICON_NAMES`
 * is what a NODE may wear as a badge, and the symbol picker derives its
 * options from that list. A picture of a routing style or of an emoji
 * category is registered geometry without being a symbol anyone can choose.
 * The signature carries its own box, since it does not share the lucide
 * 24-grid. `iconAssetSchema` judges every entry when the tables are read, so
 * a malformed one stops the plugin rather than reaching a picker.
 */
const VISUAL_ASSET_ICONS: Readonly<Record<string, IconAsset>> = {
  ...LUCIDE_ASSETS,
  ...assetTable('icon', glyphs, iconAssetSchema),
}

/**
 * What the manifest NAMES and only code can be: each facet's payload schema
 * by the pointer at its contract definition, the symbol catalog's loader and
 * the three asset tables. The tables stay TypeScript; the manifest refers to
 * them by name.
 */
export const VISUAL_HOST: PluginHost = {
  schemas: {
    'facets/visual/visual.schema.json#/$defs/VisualAxesFacet': visualAxesFacetSchema,
    'facets/visual/visual.schema.json#/$defs/VisualEdgesFacet': visualEdgesFacetSchema,
    'facets/visual/visual.schema.json#/$defs/VisualInkFacet': visualInkFacetSchema,
    'facets/visual/visual.schema.json#/$defs/VisualStrokeFacet': visualStrokeFacetSchema,
    'facets/visual/visual.schema.json#/$defs/VisualShapeFacet': visualShapeFacetSchema,
    'facets/visual/visual.schema.json#/$defs/VisualTextFacet': visualTextFacetSchema,
    'facets/visual/visual.schema.json#/$defs/VisualThemeFacet': visualThemeFacetSchema,
    'facets/visual/visual.schema.json#/$defs/VisualSymbolFacet': visualSymbolFacetSchema,
    'facets/visual/visual.schema.json#/$defs/VisualStencilFacet': visualStencilFacetSchema,
    'facets/visual/visual.schema.json#/$defs/VisualStencilsFacet': visualStencilsFacetSchema,
    'facets/visual/visual.schema.json#/$defs/VisualTagsFacet': visualTagsFacetSchema,
  },
  catalogs: { 'visual.symbols': symbolCatalogLoad },
  assets: {
    'visual.themes': VISUAL_THEMES,
    'visual.icons': VISUAL_ASSET_ICONS,
    'visual.stencils': VISUAL_STENCILS,
  },
}

/**
 * The bundled plugin, built from its manifest. Deliberately ordinary
 * (ADR-0013 decision 3): it goes through the same registry, validation and
 * ordering as any deployment's added plugins, and a deployment may disable it.
 */
export const visualPlugin = pluginFromManifest(manifest, VISUAL_HOST)

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
  const stored = canvas.facets?.[VISUAL_EDGES_KEY]
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
 * What an edge says about ITSELF, with no canvas or theme filled in — the
 * stored facet and nothing else. An editor showing "inherited unless
 * overridden" needs to know which fields the edge actually holds, and a
 * resolved value cannot say.
 *
 * The layout narrows the board's answer with it field by field, not whole
 * value: the two payloads are at DIFFERENT scopes, so an edge saying only
 * `routing` narrows that one field rather than declaring that the board's line
 * jumps do not apply to it. Whole-value replacement is the rule WITHIN one
 * scope, where a facet is one register.
 */
export function resolveEdgeOwnStyle(
  // Either element: a LINE carries the same facet bucket an edge does, and
  // what this reads is the bucket (ADR-0038 decision 2).
  edge: RoutableElement,
  registry: FacetRegistry = bundledFacetRegistry,
): VisualEdgesFacet {
  const stored = edge.facets?.[VISUAL_EDGES_KEY]
  if (stored === undefined) return {}
  const resolution = registry.resolveFacetPayload(VISUAL_EDGES_KEY, stored)
  if (resolution.kind !== 'resolved') return {}
  return visualEdgesFacetSchema.parse(resolution.value)
}

/**
 * The group a stroke belongs to, or `undefined` when it stands alone.
 *
 * Answers `undefined` for an unreadable payload rather than throwing: facets
 * round-trip unvalidated through the generic bucket, so anything may be
 * under this key, and a grouping nobody can read is no grouping — it must
 * not take the stroke down with it.
 */
export function resolveInkGroup(
  // Either element, like `resolveEdgeOwnStyle`: a LINE carries the same
  // facet bucket an edge does (ADR-0038 decision 2). Only a line is ever
  // grouped today, and nothing here has to know that.
  element: RoutableElement,
  registry: FacetRegistry = bundledFacetRegistry,
): string | undefined {
  const stored = element.facets?.[VISUAL_INK_KEY]
  if (stored === undefined) return undefined
  const resolution = registry.resolveFacetPayload(VISUAL_INK_KEY, stored)
  if (resolution.kind !== 'resolved') return undefined
  const parsed = visualInkFacetSchema.safeParse(resolution.value)
  return parsed.success ? parsed.data.group : undefined
}

/** The weight a stroke draws at: `thin` when it carries none, or none this build can read. */
export function resolveStrokeWidth(
  element: RoutableElement,
  registry: FacetRegistry = bundledFacetRegistry,
): StrokeWidth {
  const stored = element.facets?.[VISUAL_STROKE_KEY]
  if (stored === undefined) return 'thin'
  const resolution = registry.resolveFacetPayload(VISUAL_STROKE_KEY, stored)
  if (resolution.kind !== 'resolved') return 'thin'
  const parsed = visualStrokeFacetSchema.safeParse(resolution.value)
  return parsed.success ? parsed.data.width : 'thin'
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
  const stored = canvas.facets?.[VISUAL_THEME_KEY]
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
  const stored = node.facets?.[VISUAL_SHAPE_KEY]
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
  return readSymbol(node.facets, registry)
}

/** The symbol a SPATIAL document wears, stored on its canvas envelope. */
export function resolveCanvasSymbol(
  canvas: SpatialCanvas,
  registry: FacetRegistry = bundledFacetRegistry,
): VisualSymbolFacet | undefined {
  return readSymbol(canvas.facets, registry)
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
  const stored = node.facets?.[VISUAL_TEXT_KEY]
  if (stored === undefined) return undefined
  const resolution = registry.resolveFacetPayload(VISUAL_TEXT_KEY, stored)
  if (resolution.kind !== 'resolved') return undefined
  return visualTextFacetSchema.parse(resolution.value).align
}
