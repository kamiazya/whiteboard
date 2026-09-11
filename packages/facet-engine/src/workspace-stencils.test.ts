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
    expect(() =>
      withWorkspaceStencils(baseRegistry(), {
        bad: { displayName: 'Bad', facets: { 'visualish.shape/v0': { kind: 'octagon' } } },
      }),
    ).toThrow(/visualish\.shape/)
  })

  it('refuses a library whose stencil name is not a legal segment', () => {
    // The id is composed as `workspace.<name>`, so a name that cannot be a
    // segment would produce an id no `namespacedIdSchema` reader accepts —
    // a stencil the picker offers and every writer refuses.
    expect(() =>
      withWorkspaceStencils(baseRegistry(), { 'Not A Name': { displayName: 'x' } }),
    ).toThrow(/Not A Name/)
  })
})
