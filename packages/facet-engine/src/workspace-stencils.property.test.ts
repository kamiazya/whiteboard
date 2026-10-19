// Which library stencils are kept, and the message each refused one carries,
// must be exactly what a registry BUILD of that stencil alone would say. The
// oracle below is that build — one `createFacetRegistry` per entry — so the
// composer is held to the registry's own verdict rather than to a second
// spelling of its rules.
import { test } from '@fast-check/vitest'
import * as fc from 'fast-check'
import { describe, expect } from 'vitest'
import { z } from 'zod'
import {
  createFacetRegistry,
  defineFacet,
  definePlugin,
  defineWorkspaceStencilPlugin,
  type FacetPlugin,
} from './registry.js'
import type { StencilAssetInput } from './stencil.js'
import { composeWorkspaceStencils } from './workspace-stencils.js'

const shape = defineFacet({
  name: 'shape',
  displayName: 'Shape',
  version: 'v1',
  targets: ['node'],
  schema: z.object({ kind: z.enum(['ellipse', 'cylinder']) }),
  compat: { v0: { schema: z.object({ k: z.string() }), migrate: () => ({ kind: 'ellipse' }) } },
})

const badge = defineFacet({
  name: 'badge',
  displayName: 'Badge',
  version: 'v0',
  targets: ['node'],
  schema: z.object({ label: z.string().min(1) }).strict(),
})

const deployment: readonly FacetPlugin[] = [
  definePlugin({
    id: 'visualish',
    displayName: 'Visualish',
    facets: [shape, badge],
    assets: { stencils: { datastore: { displayName: 'Datastore' } } },
  }),
]

function oracle(stencils: Record<string, unknown>) {
  const kept: string[] = []
  const dropped: { name: string; message: string }[] = []
  for (const [name, stencil] of Object.entries(stencils)) {
    try {
      createFacetRegistry([
        ...deployment,
        defineWorkspaceStencilPlugin({ [name]: stencil as StencilAssetInput }),
      ])
      kept.push(`workspace.${name}`)
    } catch (error) {
      dropped.push({ name, message: (error as Error).message })
    }
  }
  return { kept, dropped }
}

const facetEntry = fc.oneof(
  fc.constant(['visualish.shape/v1', { kind: 'cylinder' }] as const),
  fc.constant(['visualish.shape/v1', { kind: 'octagon' }] as const),
  fc.constant(['visualish.shape/v0', { k: 'x' }] as const),
  fc.constant(['visualish.badge/v0', { label: 'db' }] as const),
  fc.constant(['visualish.badge/v0', { label: '', extra: 1 }] as const),
  fc.constant(['nope.nothing/v0', {}] as const),
  fc.constant(['visualish.missing/v0', {}] as const),
  fc.constant(['Not A Key', {}] as const),
)

// Weighted towards a well-shaped stencil, because only those reach the
// per-facet checks — the refusals that differ most between a stencil and its
// neighbours.
const stencil: fc.Arbitrary<unknown> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record(
      {
        displayName: fc.constant('Box'),
        color: fc.constant('3'),
        facets: fc
          .array(facetEntry, { minLength: 1, maxLength: 3 })
          .map((entries) => Object.fromEntries(entries)),
      },
      { requiredKeys: ['displayName'] },
    ),
  },
  { weight: 1, arbitrary: fc.constant({ displayName: '' }) },
  { weight: 1, arbitrary: fc.constant({ displayName: 'Box', color: '' }) },
  { weight: 1, arbitrary: fc.constant({ displayName: 'Box', x: 10 }) },
  { weight: 1, arbitrary: fc.constantFrom('not an object', null) },
)

const name = fc.oneof(
  fc.constantFrom('a', 'bucket', 'lake-house', 'Not A Name', '9lives', ''),
  fc.stringMatching(/^[a-z][a-z0-9-]{0,5}$/),
)

const library = fc.dictionary(name, stencil, { maxKeys: 8 })

describe('composing a workspace stencil library', () => {
  test('the generator reaches every refusal the registry can give, and a kept stencil', () => {
    // A domain that never produced one of these would leave the property
    // asserting nothing about it.
    const seen = new Set<string>()
    for (const sample of fc.sample(library, 400)) {
      const { kept, dropped } = oracle(sample)
      if (kept.length > 0) seen.add('kept')
      for (const { message } of dropped) {
        for (const shape of [
          'asset name',
          'plugin "workspace" stencil asset',
          'which no plugin registered',
          'not the current version',
          'payload for',
        ]) {
          if (message.includes(shape)) seen.add(shape)
        }
      }
    }
    expect([...seen].sort()).toEqual(
      [
        'asset name',
        'plugin "workspace" stencil asset',
        'kept',
        'not the current version',
        'payload for',
        'which no plugin registered',
      ].sort(),
    )
  })

  test.prop([library])(
    'keeps and drops exactly what a registry build of each stencil alone would',
    (library) => {
      const expected = oracle(library)
      const { registry, dropped } = composeWorkspaceStencils(
        createFacetRegistry(deployment),
        library as Record<string, StencilAssetInput>,
      )
      expect(dropped).toEqual(expected.dropped)
      expect(registry.assetIds('stencils')).toEqual(['visualish.datastore', ...expected.kept])
    },
  )
})
