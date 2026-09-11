// A STENCIL asset (ADR-0034): a named bundle of appearance a document
// applies to ONE node. The engine's half is deliberately ignorant of what
// the appearance MEANS — it holds the contract and validates the bundle's
// facet payloads against the schemas plugins registered, exactly as it holds
// the theme token contract without knowing what a palette looks like.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createFacetRegistry, defineFacet, definePlugin } from './registry.js'

const shapeFacet = defineFacet({
  name: 'shape',
  displayName: 'Shape',
  version: 'v0',
  targets: ['node'],
  schema: z.object({ kind: z.enum(['cylinder', 'hexagon']) }),
})

const paint = definePlugin({
  id: 'paint',
  displayName: 'Paint',
  facets: [
    shapeFacet,
    defineFacet({
      name: 'stencil',
      displayName: 'Stencil',
      version: 'v0',
      targets: ['node'],
      schema: z.object({ id: z.string().min(1) }),
      assetRefs: { id: 'stencils' },
    }),
  ],
  assets: {
    stencils: {
      datastore: {
        displayName: 'Datastore',
        color: '5',
        facets: { 'paint.shape/v0': { kind: 'cylinder' } },
      },
    },
  },
})

describe('stencil assets', () => {
  it('namespaces a stencil like any other asset and answers it by kind', () => {
    const registry = createFacetRegistry([paint])
    expect(registry.stencilAsset('paint.datastore')?.displayName).toBe('Datastore')
    expect(registry.stencilAsset('paint.datastore')?.color).toBe('5')
    expect(registry.assetIds('stencils')).toEqual(['paint.datastore'])
    // Wrong kind and bare name answer undefined, as themes and icons do.
    expect(registry.stencilAsset('datastore')).toBeUndefined()
    expect(registry.themeAsset('paint.datastore')).toBeUndefined()
  })

  it('refuses a write naming a stencil nobody registered, and lists what is', () => {
    // This is `assetRefs` doing its existing job — the point of the test is
    // that a stencil id is checked on the same path a theme id is, so a
    // deployment cannot store a reference to a vocabulary it does not have.
    const registry = createFacetRegistry([paint])
    const refused = registry.validateFacetWrite('paint.stencil/v0', { id: 'paint.nope' })
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.message).toContain('paint.datastore')
    expect(registry.validateFacetWrite('paint.stencil/v0', { id: 'paint.datastore' }).ok).toBe(true)
  })

  it('refuses a stencil whose facet payload its own plugin would refuse', () => {
    // The bundle is validated at REGISTRY BUILD, not at definePlugin: a
    // stencil may name a facet another plugin registers, so the check needs
    // every plugin present. A stencil that ships an invalid payload would
    // otherwise write one node at a time, in a deployment, silently.
    expect(() =>
      createFacetRegistry([
        definePlugin({
          id: 'bad',
          displayName: 'Bad',
          facets: [shapeFacet],
          assets: {
            stencils: {
              wrong: { displayName: 'Wrong', facets: { 'bad.shape/v0': { kind: 'trapezoid' } } },
            },
          },
        }),
      ]),
    ).toThrow(/bad\.shape\/v0/)
  })

  it('refuses a stencil naming a facet no registered plugin defines', () => {
    expect(() =>
      createFacetRegistry([
        definePlugin({
          id: 'lonely',
          displayName: 'Lonely',
          facets: [],
          assets: {
            stencils: {
              x: { displayName: 'X', facets: { 'nobody.shape/v0': { kind: 'cylinder' } } },
            },
          },
        }),
      ]),
    ).toThrow(/nobody\.shape\/v0/)
  })

  it('lets a stencil carry ANOTHER plugin’s facet, which is the point of a shared vocabulary', () => {
    const infra = definePlugin({
      id: 'infra',
      displayName: 'Infra',
      facets: [],
      assets: {
        stencils: {
          rds: { displayName: 'RDS', facets: { 'paint.shape/v0': { kind: 'cylinder' } } },
        },
      },
    })
    const registry = createFacetRegistry([paint, infra])
    expect(registry.stencilAsset('infra.rds')?.facets['paint.shape/v0']).toEqual({
      kind: 'cylinder',
    })
  })

  it('accepts a stencil that sets colour alone, and one that sets facets alone', () => {
    // Neither half is required: a stencil distinguishing by colour only is a
    // legitimate vocabulary, and so is one distinguishing by silhouette only.
    const registry = createFacetRegistry([
      definePlugin({
        id: 'thin',
        displayName: 'Thin',
        facets: [shapeFacet],
        assets: {
          stencils: {
            hot: { displayName: 'Hot', color: '1' },
            boxy: { displayName: 'Boxy', facets: { 'thin.shape/v0': { kind: 'hexagon' } } },
          },
        },
      }),
    ])
    expect(registry.stencilAsset('thin.hot')?.facets).toEqual({})
    expect(registry.stencilAsset('thin.boxy')?.color).toBeUndefined()
  })
})
