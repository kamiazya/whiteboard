import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { extensionFacetsSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { createFacetRegistry } from './registry.js'
import { bundledPlugins, resolveCanvasEdgeStyle, VISUAL_EDGES_KEY, visualPlugin } from './visual.js'

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
