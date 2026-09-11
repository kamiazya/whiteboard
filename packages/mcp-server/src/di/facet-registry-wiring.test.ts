// The plugin set is a COMPOSITION-TIME choice, and this is where a
// composition root makes it (ADR-0013 decision 3's distribution-time
// registration).
//
// Why this file exists: `deps.facetRegistry` was declared on `ServerDeps`,
// read by `facet-set`, `facet-list` and the stencil path — and supplied by
// NOTHING. Every root fell through to the bundled registry, and every test
// that exercised the seam built `deps` by hand, so the gap was invisible from
// both sides. Built-but-unwired, in this repo's own review vocabulary.
//
// What it deliberately does NOT do: load plugins named in a config file.
// ADR-0013 decision 3 forbids runtime facet definition because the
// governance and security blast radius is wider than it looks, and a config
// file naming module specifiers to import IS runtime code loading wearing a
// config file's clothes. Distribution time means whoever BUILDS or EMBEDS
// this server chooses the set, in code, which is what an argument is.
import { createFacetRegistry, definePlugin } from '@kamiazya/whiteboard-facet-engine'
import { bundledPlugins, visualPlugin } from '@kamiazya/whiteboard-plugin-visual'
import { createFacetListTool } from '@kamiazya/whiteboard-server-core'
import { describe, expect, it } from 'vitest'
import { createContainer, resolveServerDeps } from './container.js'

const pack = definePlugin({
  id: 'infra',
  displayName: 'Infra',
  facets: [],
  assets: { stencils: { bucket: { displayName: 'Bucket', color: '2' } } },
})

describe('a composition root chooses the plugin set', () => {
  it('supplies a registry rather than leaving every tool to fall back', () => {
    // The seam is LIVE: absent here, each tool's own `?? bundledFacetRegistry`
    // silently answered, so nothing could tell a configured deployment from
    // an unconfigured one.
    const deps = resolveServerDeps(createContainer())
    expect(deps.facetRegistry).toBeDefined()
  })

  it('defaults to the bundled plugins, so an unconfigured daemon is unchanged', () => {
    const deps = resolveServerDeps(createContainer())
    expect(deps.facetRegistry?.plugins).toEqual(bundledPlugins)
  })

  it('carries a set the root passed, including a plugin this repo did not ship', () => {
    const deps = resolveServerDeps(createContainer(), { plugins: [visualPlugin, pack] })
    expect(deps.facetRegistry?.assetIds('stencils')).toContain('infra.bucket')
  })

  it('lets a deployment leave the bundled plugin OUT, which ADR-0013 promises', () => {
    // "The bundled plugin goes through this same pipeline with no privileged
    // wiring — it is ordinary, disable-able". A root that composes only its
    // own plugins must get exactly those.
    const deps = resolveServerDeps(createContainer(), { plugins: [pack] })
    expect(deps.facetRegistry?.plugins.map((plugin) => plugin.id)).toEqual(['infra'])
    expect(deps.facetRegistry?.assetIds('stencils')).toEqual(['infra.bucket'])
  })

  it('builds the registry ONCE, since it is immutable data and every call reads it', () => {
    const deps = resolveServerDeps(createContainer())
    const again = resolveServerDeps(createContainer())
    // Two roots are two registries; one root is one. What must not happen is
    // a fresh registry per tool call, which is what a `?? createFacetRegistry(...)`
    // inside a handler would have produced.
    expect(deps.facetRegistry).toBe(deps.facetRegistry)
    expect(deps.facetRegistry).not.toBe(again.facetRegistry)
  })

  it('accepts a registry the root already built, not only a plugin list', () => {
    // A root that needs the registry for something else (a renderer, a
    // picker) must not be forced to build a second one that disagrees.
    const registry = createFacetRegistry([visualPlugin, pack])
    const deps = resolveServerDeps(createContainer(), { facetRegistry: registry })
    expect(deps.facetRegistry).toBe(registry)
  })

  it('reaches an actual TOOL, which is the half the seam existed for', async () => {
    // The claim this file is really making. `wb_facet_list` is the discovery
    // answer, so if a configured plugin does not reach it, nothing a
    // deployment registers is findable — which is the state that shipped.
    //
    // Through the real `resolveServerDeps`, not a hand-built `deps`: the
    // hand-built kind is exactly what hid the gap, because it supplied the
    // registry the production path never did.
    const deps = resolveServerDeps(createContainer(), { plugins: [visualPlugin, pack] })
    const result = await createFacetListTool(deps).execute({ assetKind: 'stencils' })
    expect(result.assets.map((asset) => asset.id)).toContain('infra.bucket')
  })
})
