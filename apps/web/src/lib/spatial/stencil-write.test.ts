// The inspector's stencil row and `wb_canvas_edit`'s `stencil` field must leave
// a node in the same state (ADR-0034 decision 5). The expectation is read from
// the stencil ASSET, not from `applyStencil`, so a stencil whose expansion
// the web path stopped carrying fails here even if the shared helper is
// unchanged.

import { withWorkspaceStencils } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import {
  applyStencil,
  bundledFacetRegistry,
  VISUAL_STENCIL_KEY,
} from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it } from 'vitest'
import { applyCommand } from './commands.js'
import { stencilWriteCommands } from './stencil-write.js'

const plain = textNode({ id: 'n', x: 0, y: 0, width: 100, height: 50, text: 'box' })
const canvasOf = (node: typeof plain): SpatialCanvas => ({ nodes: [node], edges: [] })

const dress = (node: typeof plain, id: string | undefined, registry = bundledFacetRegistry) => {
  const canvas = stencilWriteCommands(
    node,
    id === undefined ? undefined : { stencil: id },
    registry,
  ).reduce(applyCommand, canvasOf(node))
  return canvas.nodes[0]!
}

const bundledIds = bundledFacetRegistry.assetIds('stencils')

describe('the stencil write', () => {
  it('has the bundled stencils to cover', () => {
    expect(bundledIds.length).toBeGreaterThanOrEqual(6)
  })

  it.each(bundledIds)('%s leaves its appearance and its record on the node', (id) => {
    const asset = bundledFacetRegistry.stencilAsset(id)!
    const dressed = dress(plain, id)
    expect(dressed.facets).toEqual({ ...asset.facets, [VISUAL_STENCIL_KEY]: { stencil: id } })
    expect(dressed.color).toBe(asset.color)
  })

  it.each(bundledIds)('%s is the node the tool path produces', (id) => {
    expect(dress(plain, id)).toEqual(applyStencil(plain, id))
  })

  it('re-dressing from any stencil to any other matches the tool path', () => {
    for (const from of bundledIds) {
      const worn = applyStencil(plain, from)!
      for (const to of bundledIds) {
        expect(dress(worn, to), `${from} -> ${to}`).toEqual(applyStencil(worn, to))
      }
    }
  })

  it('writes nothing for a stencil the registry does not hold', () => {
    expect(stencilWriteCommands(plain, { stencil: 'visual.nope' })).toEqual([])
    expect(stencilWriteCommands(plain, { stencil: 3 })).toEqual([])
  })

  it.each(bundledIds)('clearing %s restores the undressed node', (id) => {
    expect(dress(applyStencil(plain, id)!, undefined)).toEqual(plain)
  })

  it('clearing a box that wears no stencil writes nothing', () => {
    expect(stencilWriteCommands(plain, undefined)).toEqual([])
  })
})

describe('a stencil that spends colour', () => {
  const registry = withWorkspaceStencils(bundledFacetRegistry, {
    lakehouse: {
      displayName: 'Lakehouse',
      color: '4',
      facets: { 'visual.shape/v0': { kind: 'hexagon' } },
    },
  })

  it('dresses with the colour and clears it again, as re-dressing does', () => {
    const dressed = dress(plain, 'workspace.lakehouse', registry)
    expect(dressed.color).toBe('4')
    expect(dress(dressed, 'visual.datastore', registry)).toEqual(
      applyStencil(dressed, 'visual.datastore', registry),
    )
    expect(dress(dressed, 'visual.datastore', registry).color).toBeUndefined()
    expect(dress(dressed, undefined, registry)).toEqual(plain)
  })

  it('keeps a colour the person set after dressing when the stencil is cleared', () => {
    const recoloured = { ...dress(plain, 'workspace.lakehouse', registry), color: '2' }
    expect(dress(recoloured, undefined, registry).color).toBe('2')
  })
})
