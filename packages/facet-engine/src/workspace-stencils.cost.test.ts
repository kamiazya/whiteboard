// What composing a REFUSED library costs, counted in registry builds.
//
// A library is content, its entry count is whatever was written or synced,
// and it is recomposed on every read that resolves a stencil. A build per
// entry makes one bad library cost as many full registry builds as it has
// entries — on a write before the refusal, and again on every read after.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const builds = vi.hoisted(() => ({ count: 0 }))

vi.mock('./registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./registry.js')>()
  return {
    ...actual,
    createFacetRegistry: (...args: Parameters<typeof actual.createFacetRegistry>) => {
      builds.count += 1
      return actual.createFacetRegistry(...args)
    },
  }
})

import { createFacetRegistry, defineFacet, definePlugin } from './registry.js'
import type { StencilAssetInput } from './stencil.js'
import { composeWorkspaceStencils } from './workspace-stencils.js'

const shape = defineFacet({
  name: 'shape',
  displayName: 'Shape',
  version: 'v0',
  targets: ['node'],
  schema: z.object({ kind: z.enum(['ellipse', 'cylinder']) }),
})

const base = definePlugin({ id: 'visualish', displayName: 'Visualish', facets: [shape] })

function library(size: number, entry: (index: number) => StencilAssetInput) {
  return Object.fromEntries(
    Array.from({ length: size }, (_, index) => [`s${index}`, entry(index)] as const),
  )
}

describe('composing a refused workspace stencil library', () => {
  beforeEach(() => {
    builds.count = 0
  })

  it('builds the registry once however many entries are refused', () => {
    const registry = createFacetRegistry([base])
    const bad = library(200, () => ({ displayName: 'x', facets: { 'nope.nothing/v0': {} } }))
    builds.count = 0

    const { dropped } = composeWorkspaceStencils(registry, bad)

    expect(dropped).toHaveLength(200)
    expect(builds.count).toBe(1)
  })

  it('builds once for a library that mixes kept and refused entries', () => {
    const registry = createFacetRegistry([base])
    const mixed = library(200, (index) =>
      index % 2 === 0
        ? { displayName: 'ok', facets: { 'visualish.shape/v0': { kind: 'ellipse' } } }
        : { displayName: 'bad', facets: { 'visualish.shape/v0': { kind: 'octagon' } } },
    )
    builds.count = 0

    const { registry: composed, dropped } = composeWorkspaceStencils(registry, mixed)

    expect(dropped).toHaveLength(100)
    expect(composed.assetIds('stencils')).toHaveLength(100)
    expect(builds.count).toBe(1)
  })
})
