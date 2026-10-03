// The plugin set is fixed at build time: rendering, export and the web editor
// read the bundled plugin directly, so the registry the tools validate
// against must be that same composition or writes and drawings disagree
// (ADR-0013's 2026-10-03 note). Every root hands the tools one bundled
// registry, supplied rather than left to each tool's own fallback.

import { bundledFacetRegistry, bundledPlugins } from '@kamiazya/whiteboard-plugin-visual'
import { createFacetListTool } from '@kamiazya/whiteboard-server-core'
import { describe, expect, it } from 'vitest'
import { withTempDataDir } from '../server/routes/_test-helpers.js'
import { getDb } from '../server/store/db/index.js'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import { createContainer, resolveServerDeps } from './container.js'
import { resolveSelfHostServerDeps } from './self-host-server-deps.js'

const tmp = withTempDataDir('whiteboard-facet-wiring-')

describe('every root hands the tools the one bundled registry', () => {
  it('supplies a registry rather than leaving every tool to fall back', () => {
    const deps = resolveServerDeps(createContainer(storeMemoryModule))
    expect(deps.facetRegistry).toBeDefined()
  })

  it('composes exactly the bundled plugins', () => {
    const deps = resolveServerDeps(createContainer(storeMemoryModule))
    expect(deps.facetRegistry.plugins).toEqual(bundledPlugins)
    expect(deps.facetRegistry.assetIds('stencils')).toEqual(
      bundledFacetRegistry.assetIds('stencils'),
    )
  })

  it('composes the same set for a self-host root', async () => {
    const db = await getDb(tmp.dir)
    const deps = resolveSelfHostServerDeps(db, tmp.dir)
    expect(deps.facetRegistry.plugins).toEqual(bundledPlugins)
  })

  it('builds the registry ONCE per root, since it is immutable data and every call reads it', () => {
    const deps = resolveServerDeps(createContainer(storeMemoryModule))
    const again = resolveServerDeps(createContainer(storeMemoryModule))
    expect(deps.facetRegistry).toBe(deps.facetRegistry)
    expect(deps.facetRegistry).not.toBe(again.facetRegistry)
  })

  it('reaches an actual TOOL, which is the half the seam exists for', async () => {
    // Through the real `resolveServerDeps`, not a hand-built `deps`: the
    // hand-built kind is what once hid a seam no root supplied.
    const deps = resolveServerDeps(createContainer(storeMemoryModule))
    const result = await createFacetListTool(deps).execute({ assetKind: 'stencils' })
    expect(result.assets.length).toBeGreaterThan(0)
    expect(result.assets.map((asset) => asset.id)).toEqual(
      expect.arrayContaining(bundledFacetRegistry.assetIds('stencils') as string[]),
    )
  })
})
