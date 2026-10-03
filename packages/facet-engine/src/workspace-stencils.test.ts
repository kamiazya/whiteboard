// Composing a workspace's own stencil library into a registry (ADR-0034's
// amendment): base plugins plus a SYNTHETIC plugin carrying that workspace's
// stencils, rather than a second lookup beside the first.
//
// One producer is the whole point. `applyStencil`, the asset picker and
// `wb_facet_list` all read a registry; a second resolution path would have to
// be taught to each of them, and the one that was not taught would answer a
// stencil the others could not see.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  composeWorkspaceStencils,
  createFacetRegistry,
  defineFacet,
  definePlugin,
  type FacetPlugin,
  WORKSPACE_PLUGIN_ID,
  withWorkspaceStencils,
} from './index.js'

const shape = defineFacet({
  name: 'shape',
  displayName: 'Shape',
  version: 'v0',
  targets: ['node'],
  schema: z.object({ kind: z.enum(['ellipse', 'cylinder']) }),
})

const base: FacetPlugin = definePlugin({
  id: 'visualish',
  displayName: 'Visualish',
  facets: [shape],
  assets: { stencils: { datastore: { displayName: 'Datastore', color: '5' } } },
})

const baseRegistry = () => createFacetRegistry([base])

describe('a workspace stencil library', () => {
  it('registers each of its stencils under the reserved workspace namespace', () => {
    const registry = withWorkspaceStencils(baseRegistry(), {
      bucket: {
        displayName: 'Bucket',
        color: '2',
        facets: { 'visualish.shape/v0': { kind: 'cylinder' } },
      },
    })

    expect(registry.stencilAsset(`${WORKSPACE_PLUGIN_ID}.bucket`)?.displayName).toBe('Bucket')
    expect(registry.assetIds('stencils')).toEqual(['visualish.datastore', 'workspace.bucket'])
  })

  it('leaves the deployment’s own stencils resolvable beside them', () => {
    const registry = withWorkspaceStencils(baseRegistry(), {
      bucket: { displayName: 'Bucket' },
    })

    expect(registry.stencilAsset('visualish.datastore')?.color).toBe('5')
  })

  it('answers the SAME registry when the library is empty, so nothing is rebuilt for nothing', () => {
    // A registry is immutable data whose compat chains and asset tables are
    // built once. The overwhelmingly common workspace has no library at all,
    // and it must not pay for the ones that do.
    const registry = baseRegistry()
    expect(withWorkspaceStencils(registry, {})).toBe(registry)
  })

  it('validates a library stencil’s facet payloads against the plugin that owns them', () => {
    // The safety claim ADR-0034's amendment makes: a library defines no
    // schema, so every payload in it is checked by the schema its own plugin
    // registered. A library that could write an unvalidated facet would be
    // the runtime schema definition ADR-0013 decision 3 forbids.
    const { registry, dropped } = composeWorkspaceStencils(baseRegistry(), {
      bad: { displayName: 'Bad', facets: { 'visualish.shape/v0': { kind: 'octagon' } } },
    })
    expect(registry.stencilAsset('workspace.bad')).toBeUndefined()
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.name).toBe('bad')
    expect(dropped[0]?.message).toMatch(/workspace\.bad.*visualish\.shape\/v0/)
  })

  it('drops only the stencil that is refused, so the rest of the library and the deployment stay usable', () => {
    // A library is composed on every read. One entry the registry refuses
    // used to take the whole composition down, the deployment's own stencils
    // included.
    const { registry, dropped } = composeWorkspaceStencils(baseRegistry(), {
      aaa: { displayName: 'First' },
      bad: { displayName: 'Bad', facets: { 'visualish.shape/v0': { kind: 'octagon' } } },
      unregistered: { displayName: 'U', facets: { 'nope.nothing/v0': { a: 1 } } },
      zzz: { displayName: 'Last', facets: { 'visualish.shape/v0': { kind: 'cylinder' } } },
    })
    expect(registry.assetIds('stencils')).toEqual([
      'visualish.datastore',
      'workspace.aaa',
      'workspace.zzz',
    ])
    expect(dropped.map((entry) => entry.name)).toEqual(['bad', 'unregistered'])
    expect(dropped[1]?.message).toMatch(/nope\.nothing\/v0/)
  })

  it('answers the deployment alone when every stencil is refused', () => {
    const { registry } = composeWorkspaceStencils(baseRegistry(), {
      bad: { displayName: 'Bad', facets: { 'visualish.shape/v0': { kind: 'octagon' } } },
    })
    expect(registry.assetIds('stencils')).toEqual(['visualish.datastore'])
  })

  it('reports nothing dropped for a library that is wholly valid', () => {
    expect(composeWorkspaceStencils(baseRegistry(), { ok: { displayName: 'Ok' } }).dropped).toEqual(
      [],
    )
  })

  it('drops a stencil whose name is not a legal segment', () => {
    // The id is composed as `workspace.<name>`, so a name that cannot be a
    // segment would produce an id no `namespacedIdSchema` reader accepts —
    // a stencil the picker offers and every writer refuses.
    const { registry, dropped } = composeWorkspaceStencils(baseRegistry(), {
      'Not A Name': { displayName: 'x' },
      fine: { displayName: 'Fine' },
    })
    expect(registry.assetIds('stencils')).toEqual(['visualish.datastore', 'workspace.fine'])
    expect(dropped[0]?.message).toMatch(/Not A Name/)
  })
})

describe('the reserved namespace, as a public surface', () => {
  it('exposes no way to define a workspace plugin by hand', async () => {
    // The reservation is the whole safety of composing a synthetic plugin:
    // `createFacetRegistry` throws on a duplicate plugin id, so a public
    // bypass would turn "a deployment may not take this id" into a crash the
    // first time a workspace grew a library. `definePlugin` refuses it; the
    // engine's own validator must not be reachable to undo that.
    //
    // lazy-import: the SUBJECT is the module's export surface, so it has to
    // be read as a whole rather than named import by import.
    const engine = await import('./index.js')
    expect(Object.keys(engine)).not.toContain('validatePluginForEngine')
  })

  it('composes over a registry that already carries a library, rather than colliding', () => {
    // Reachable by any caller that composes twice — a re-read after the
    // library document changed, say. Appending blindly would hand
    // `createFacetRegistry` two `workspace` plugins and throw.
    const once = withWorkspaceStencils(baseRegistry(), { bucket: { displayName: 'Bucket' } })
    const twice = withWorkspaceStencils(once, { crate: { displayName: 'Crate' } })

    expect(twice.assetIds('stencils')).toEqual(['visualish.datastore', 'workspace.crate'])
  })
})
