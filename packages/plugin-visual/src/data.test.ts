import { createFacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { extensionFacetsSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import {
  bundledPlugins,
  resolveCanvasEdgeStyle,
  resolveCanvasSymbol,
  resolveCanvasTheme,
  resolveDocumentSymbol,
  resolveNodeShape,
  resolveNodeSymbol,
  resolveNodeTextAlign,
  VISUAL_EDGES_KEY,
  VISUAL_SHAPE_KEY,
  VISUAL_SYMBOL_KEY,
  VISUAL_TEXT_KEY,
  VISUAL_THEME_KEY,
  visualPlugin,
  visualSymbolFacetSchema,
} from './data.js'

const registry = createFacetRegistry(bundledPlugins)

const canvasWith = (extension: SpatialCanvas['x-whiteboard']): SpatialCanvas => ({
  nodes: [],
  edges: [],
  'x-whiteboard': extension,
})

describe('visualPlugin', () => {
  it('registers visual.edges/v0 as a canvas-target facet', () => {
    expect(VISUAL_EDGES_KEY).toBe('visual.edges/v0')
    expect(registry.targetsOf(VISUAL_EDGES_KEY)).toEqual(['canvas'])
  })

  it('every bundled facet key satisfies the model key grammar', () => {
    for (const plugin of bundledPlugins) {
      for (const facet of plugin.facets) {
        const key = `${plugin.id}.${facet.name}/${facet.version}`
        expect(extensionFacetsSchema.safeParse({ [key]: {} }).success).toBe(true)
      }
    }
  })

  it('validates edges payloads: enums only, no raw styles', () => {
    expect(registry.validateFacetWrite(VISUAL_EDGES_KEY, { routing: 'curved' }).ok).toBe(true)
    expect(registry.validateFacetWrite(VISUAL_EDGES_KEY, { routing: 'spiral' }).ok).toBe(false)
    expect(registry.validateFacetWrite(VISUAL_EDGES_KEY, { lineJumps: 'arc' }).ok).toBe(true)
  })
})

describe('resolveCanvasEdgeStyle', () => {
  it('reads the visual.edges facet when present', () => {
    const canvas = canvasWith({
      facets: { [VISUAL_EDGES_KEY]: { routing: 'curved', lineJumps: 'arc' } },
    })
    expect(resolveCanvasEdgeStyle(canvas, registry)).toEqual({ style: 'curved', lineJumps: 'arc' })
  })

  it('falls back to the legacy edgeRouting preference when the facet is absent', () => {
    const canvas = canvasWith({ edgeRouting: { style: 'orthogonal', lineJumps: 'arc' } })
    expect(resolveCanvasEdgeStyle(canvas, registry)).toEqual({
      style: 'orthogonal',
      lineJumps: 'arc',
    })
  })

  it('the facet takes whole-value precedence over the legacy preference', () => {
    // Whole-value, not per-field: the facet is one register (replace
    // semantics), so a facet that says only `routing` means "and default
    // line jumps", never "merge with whatever the legacy key held".
    const canvas = canvasWith({
      edgeRouting: { style: 'orthogonal', lineJumps: 'arc' },
      facets: { [VISUAL_EDGES_KEY]: { routing: 'curved' } },
    })
    expect(resolveCanvasEdgeStyle(canvas, registry)).toEqual({ style: 'curved' })
  })

  it('an unresolvable facet payload falls back to the legacy preference', () => {
    const canvas = canvasWith({
      edgeRouting: { style: 'orthogonal' },
      facets: { [VISUAL_EDGES_KEY]: { routing: 'spiral' } },
    })
    expect(resolveCanvasEdgeStyle(canvas, registry)).toEqual({ style: 'orthogonal' })
  })

  it('answers an empty style for a canvas with neither', () => {
    expect(resolveCanvasEdgeStyle(canvasWith(undefined), registry)).toEqual({})
  })
})

describe('bundledPlugins', () => {
  it('contains exactly the visual plugin (no privileged extras)', () => {
    expect(bundledPlugins).toEqual([visualPlugin])
  })
})

describe('visual.shape/v0', () => {
  it('registers as a node-target facet with the silhouette vocabulary', () => {
    expect(VISUAL_SHAPE_KEY).toBe('visual.shape/v0')
    expect(registry.targetsOf(VISUAL_SHAPE_KEY)).toEqual(['node'])
    expect(registry.validateFacetWrite(VISUAL_SHAPE_KEY, { kind: 'hexagon' }).ok).toBe(true)
    expect(registry.validateFacetWrite(VISUAL_SHAPE_KEY, { kind: 'star' }).ok).toBe(false)
  })
})

describe('resolveNodeShape', () => {
  const nodeWith = (extension: SpatialCanvas['nodes'][number]['x-whiteboard']) =>
    ({
      id: 'n1',
      type: 'text',
      text: '',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      'x-whiteboard': extension,
    }) as SpatialCanvas['nodes'][number]

  it('answers the facet silhouette kind', () => {
    expect(
      resolveNodeShape(
        nodeWith({ facets: { [VISUAL_SHAPE_KEY]: { kind: 'cylinder' } } }),
        registry,
      ),
    ).toBe('cylinder')
  })

  it('answers undefined without the facet (absent = the historic rect)', () => {
    expect(resolveNodeShape(nodeWith(undefined), registry)).toBeUndefined()
    expect(resolveNodeShape(nodeWith({ facets: {} }), registry)).toBeUndefined()
  })

  it('answers undefined for an unresolvable payload (drop-not-fail)', () => {
    expect(
      resolveNodeShape(nodeWith({ facets: { [VISUAL_SHAPE_KEY]: { kind: 'star' } } }), registry),
    ).toBeUndefined()
  })

  it('reads the facet beside an embed', () => {
    expect(
      resolveNodeShape(
        nodeWith({
          kind: 'embed',
          documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7',
          facets: { [VISUAL_SHAPE_KEY]: { kind: 'diamond' } },
        }),
        registry,
      ),
    ).toBe('diamond')
  })
})

describe('visual.symbol/v0', () => {
  const nodeWith = (extension: SpatialCanvas['nodes'][number]['x-whiteboard']) =>
    ({
      id: 'n1',
      type: 'text',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      text: '',
      ...(extension === undefined ? {} : { 'x-whiteboard': extension }),
    }) as SpatialCanvas['nodes'][number]

  it('registers on all three targets: a node, a canvas, and a document', () => {
    // The question is the same wherever it is asked — "what symbolises this
    // object" — so it stays ONE facet and the value space is untouched
    // (ADR-0013's growth rule). Only where it may attach widens, and
    // `targets` is not payload, so `v0` does not move.
    expect(VISUAL_SYMBOL_KEY).toBe('visual.symbol/v0')
    expect(registry.targetsOf(VISUAL_SYMBOL_KEY)).toEqual(['node', 'canvas', 'document'])
  })

  it('the payload is a union: an icon by name or an emoji by character', () => {
    expect(visualSymbolFacetSchema.parse({ kind: 'icon', name: 'star' })).toEqual({
      kind: 'icon',
      name: 'star',
    })
    expect(visualSymbolFacetSchema.parse({ kind: 'emoji', char: '✅' })).toEqual({
      kind: 'emoji',
      char: '✅',
    })
    expect(visualSymbolFacetSchema.safeParse({ kind: 'icon', name: '' }).success).toBe(false)
    expect(visualSymbolFacetSchema.safeParse({ kind: 'emoji', char: '' }).success).toBe(false)
    // A badge is ONE glyph. Multi-codepoint clusters (variation selectors,
    // ZWJ families, flags) are one grapheme and stay valid; two symbols are
    // not a badge and would overflow the fixed box.
    expect(visualSymbolFacetSchema.safeParse({ kind: 'emoji', char: '⚠️' }).success).toBe(true)
    expect(visualSymbolFacetSchema.safeParse({ kind: 'emoji', char: '👨‍👩‍👧‍👦' }).success).toBe(
      true,
    )
    expect(visualSymbolFacetSchema.safeParse({ kind: 'emoji', char: '🇯🇵' }).success).toBe(true)
    expect(visualSymbolFacetSchema.safeParse({ kind: 'emoji', char: '✅🔥' }).success).toBe(false)
    expect(visualSymbolFacetSchema.safeParse({ kind: 'emoji', char: 'ab' }).success).toBe(false)
    // NOT emoji-only: the scene node this feeds documents a CJK character
    // or a dingbat as intended badge content, so the facet may not be
    // narrower than the substrate it draws through.
    expect(visualSymbolFacetSchema.safeParse({ kind: 'emoji', char: '重' }).success).toBe(true)
    expect(visualSymbolFacetSchema.safeParse({ kind: 'emoji', char: '✽' }).success).toBe(true)
    expect(visualSymbolFacetSchema.safeParse({ kind: 'image', href: 'x' }).success).toBe(false)
  })

  it('resolveNodeSymbol answers the stored symbol, undefined when absent or unresolvable', () => {
    expect(
      resolveNodeSymbol(
        nodeWith({ facets: { [VISUAL_SYMBOL_KEY]: { kind: 'icon', name: 'star' } } }),
        registry,
      ),
    ).toEqual({ kind: 'icon', name: 'star' })
    expect(
      resolveNodeSymbol(
        nodeWith({ facets: { [VISUAL_SYMBOL_KEY]: { kind: 'emoji', char: '⚠️' } } }),
        registry,
      ),
    ).toEqual({ kind: 'emoji', char: '⚠️' })
    expect(resolveNodeSymbol(nodeWith(undefined), registry)).toBeUndefined()
    expect(
      resolveNodeSymbol(nodeWith({ facets: { [VISUAL_SYMBOL_KEY]: { bogus: true } } }), registry),
    ).toBeUndefined()
  })

  it('resolveCanvasSymbol reads the canvas-level bucket, the way the edges facet does', () => {
    expect(
      resolveCanvasSymbol(
        canvasWith({ facets: { [VISUAL_SYMBOL_KEY]: { kind: 'emoji', char: '📌' } } }),
        registry,
      ),
    ).toEqual({ kind: 'emoji', char: '📌' })
    expect(resolveCanvasSymbol(canvasWith(undefined), registry)).toBeUndefined()
    expect(resolveCanvasSymbol(canvasWith({ facets: {} }), registry)).toBeUndefined()
  })

  it('resolveDocumentSymbol reads an OKF frontmatter facets bucket', () => {
    // A bucket rather than a document: this package has no way to open a
    // stored document, and the caller already holds the frontmatter it
    // parsed.
    expect(
      resolveDocumentSymbol({ [VISUAL_SYMBOL_KEY]: { kind: 'icon', name: 'star' } }, registry),
    ).toEqual({ kind: 'icon', name: 'star' })
    expect(resolveDocumentSymbol(undefined, registry)).toBeUndefined()
    expect(resolveDocumentSymbol({}, registry)).toBeUndefined()
  })

  it('a payload the schema refuses answers undefined on every target', () => {
    // One reader under all three, so a surface cannot invent its own idea
    // of what a broken payload means. `✅🔥` is two graphemes — the exact
    // case the schema exists to refuse.
    const broken = { [VISUAL_SYMBOL_KEY]: { kind: 'emoji', char: '✅🔥' } }
    expect(resolveNodeSymbol(nodeWith({ facets: broken }), registry)).toBeUndefined()
    expect(resolveCanvasSymbol(canvasWith({ facets: broken }), registry)).toBeUndefined()
    expect(resolveDocumentSymbol(broken, registry)).toBeUndefined()
  })
})

describe('visual.text/v0', () => {
  const nodeWith = (extension: SpatialCanvas['nodes'][number]['x-whiteboard']) =>
    ({
      id: 'n1',
      type: 'text',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      text: '',
      ...(extension === undefined ? {} : { 'x-whiteboard': extension }),
    }) as SpatialCanvas['nodes'][number]

  it('registers node-targeted, under the fixed key, declaring its own band', () => {
    expect(VISUAL_TEXT_KEY).toBe('visual.text/v0')
    expect(registry.targetsOf(VISUAL_TEXT_KEY)).toEqual(['node'])
    const definition = registry.plugins
      .flatMap((plugin) => plugin.facets)
      .find((facet) => facet.name === 'text')
    // Declared, not hand-written — the tier-2 path, like visual.shape.
    expect(definition?.editor?.fields.align?.widget).toBe('segmented')
    expect(definition?.editor?.fields.align?.quick).toBe(true)
  })

  it('resolveNodeTextAlign answers the stored choice, else undefined', () => {
    expect(
      resolveNodeTextAlign(
        nodeWith({ facets: { [VISUAL_TEXT_KEY]: { align: 'center' } } }),
        registry,
      ),
    ).toBe('center')
    expect(
      resolveNodeTextAlign(
        nodeWith({ facets: { [VISUAL_TEXT_KEY]: { align: 'start' } } }),
        registry,
      ),
    ).toBe('start')
    // Absent means "however this node would place text anyway" — the facet
    // OVERRIDES a default, it does not restate one.
    expect(resolveNodeTextAlign(nodeWith(undefined), registry)).toBeUndefined()
    expect(
      resolveNodeTextAlign(
        nodeWith({ facets: { [VISUAL_TEXT_KEY]: { align: 'middle' } } }),
        registry,
      ),
    ).toBeUndefined()
  })
})

describe('visual.theme/v0', () => {
  it('is a canvas-target facet whose payload names a registered theme asset', () => {
    expect(VISUAL_THEME_KEY).toBe('visual.theme/v0')
    expect(registry.targetsOf(VISUAL_THEME_KEY)).toEqual(['canvas'])
    expect(registry.assetIds('themes')).toEqual(['visual.sketch', 'visual.neon'])
    expect(registry.validateFacetWrite(VISUAL_THEME_KEY, { theme: 'visual.sketch' }).ok).toBe(true)
    expect(registry.validateFacetWrite(VISUAL_THEME_KEY, { theme: 'visual.neon' }).ok).toBe(true)
  })

  it('refuses a theme no plugin registered, and a bare name', () => {
    expect(registry.validateFacetWrite(VISUAL_THEME_KEY, { theme: 'visual.chalk' }).ok).toBe(false)
    expect(registry.validateFacetWrite(VISUAL_THEME_KEY, { theme: 'sketch' }).ok).toBe(false)
  })

  it('resolveCanvasTheme reads the facet and answers undefined without one', () => {
    expect(
      resolveCanvasTheme(
        canvasWith({ facets: { [VISUAL_THEME_KEY]: { theme: 'visual.neon' } } }),
        registry,
      ),
    ).toBe('visual.neon')
    expect(resolveCanvasTheme(canvasWith(undefined), registry)).toBeUndefined()
    // A stored id from elsewhere is data: resolved, and left to the renderer to degrade.
    expect(
      resolveCanvasTheme(
        canvasWith({ facets: { [VISUAL_THEME_KEY]: { theme: 'infra.aws' } } }),
        registry,
      ),
    ).toBe('infra.aws')
  })

  it('declares a segmented picker whose null segment is the bundled look', () => {
    const facet = visualPlugin.facets.find((f) => f.name === 'theme')
    const options = facet?.editor?.fields.theme?.options ?? []
    expect(options.map((o) => o.value)).toEqual([null, 'visual.sketch', 'visual.neon'])
  })
})
