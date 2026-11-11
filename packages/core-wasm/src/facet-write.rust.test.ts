import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FACET_BUCKET_CHECK_CAPS } from './generated/input-caps.js'
import { CoreInputRefused } from './index.js'
import { loadCore } from './load.js'

// The shim over the real artifact; the facet write is held to the server's
// `partitionFacetWrites` by server-core's `facet-write.core.test.ts`.
const bytes = () => readFileSync(new URL('../artifacts/whiteboard_wasm_bg.wasm', import.meta.url))
const core = await loadCore(bytes())

describe('the facet write through the artifact', () => {
  it('stores what the schema parsed and names the keys it deletes', () => {
    const result = core.facetBucketCheck('node', {
      'visual.shape/v0': { kind: 'cylinder' },
      'visual.text/v0': null,
      'other.facet/v0': { n: -0, list: [1.5, 'x'] },
    })
    expect(result).toEqual({
      ok: true,
      sets: {
        'visual.shape/v0': { kind: 'cylinder' },
        'other.facet/v0': { n: -0, list: [1.5, 'x'] },
      },
      deletions: ['visual.text/v0'],
    })
    if (result.ok)
      expect(Object.is((result.sets['other.facet/v0'] as { n: number }).n, -0)).toBe(true)
  })

  it('refuses at each stage with what the stage says', () => {
    const refusal = (
      target: 'node' | 'canvas' | 'document',
      bucket: Record<string, unknown>,
      library?: Record<string, unknown>,
    ) => {
      const result = core.facetBucketCheck(target, bucket, library)
      return result.ok ? undefined : { key: result.key, ...result.refusal }
    }
    expect(refusal('canvas', { 'visual.shape/v0': { kind: 'cylinder' } })).toEqual({
      key: 'visual.shape/v0',
      stage: 'target',
      targets: ['node'],
    })
    expect(refusal('node', { nope: 1 })).toMatchObject({ stage: 'malformed-key' })
    expect(refusal('node', { 'visual.shape/v3': {} })).toMatchObject({
      stage: 'not-current',
      current: 'visual.shape/v0',
    })
    expect(refusal('node', { 'visual.shape/v0': { kind: 'blob' } })).toMatchObject({
      stage: 'invalid',
      issues: [{ path: ['kind'], code: 'invalid_value' }],
    })
    expect(refusal('node', { 'visual.shape/v0': { kind: 'cylinder', extra: 1 } })).toMatchObject({
      stage: 'unrecognized-key',
      path: [],
      key: 'extra',
    })
    const stencil = { 'visual.stencil/v0': { stencil: 'workspace.mine' } }
    expect(refusal('node', stencil)).toMatchObject({
      stage: 'unregistered-asset',
      field: 'stencil',
      id: 'workspace.mine',
      kind: 'stencils',
    })
    expect(refusal('node', stencil, { mine: { displayName: 'Mine' } })).toBeUndefined()
    const library = {
      'visual.stencils/v0': {
        stencils: { a: { displayName: 'A', facets: { 'visual.nothing/v0': {} } } },
      },
    }
    expect(refusal('document', library)).toEqual({
      key: 'visual.stencils/v0',
      stage: 'library',
      dropped: [{ name: 'a', why: 'facet', key: 'visual.nothing/v0', facet: 'unregistered' }],
    })
  })

  it('stops at the key whose payload holds the reserved key', () => {
    const reserved = JSON.parse('{"__proto__": 1}') as object
    expect(
      core.facetBucketCheck('node', {
        'visual.shape/v0': { kind: 'cylinder' },
        'x.y/v0': reserved,
      }),
    ).toEqual({ ok: false, key: 'x.y/v0', refusal: { stage: 'reserved-key' } })
  })

  it('declines a payload nested past the cap and one holding more values than it, and a call past the bytes', () => {
    const nested = (levels: number) => {
      let value: unknown = true
      for (let i = 0; i < levels; i++) value = [value]
      return value
    }
    expect(
      core.facetBucketCheck('node', { 'x.y/v0': nested(FACET_BUCKET_CHECK_CAPS.maxDepth - 1) }).ok,
    ).toBe(true)
    expect(() =>
      core.facetBucketCheck('node', { 'x.y/v0': nested(FACET_BUCKET_CHECK_CAPS.maxDepth) }),
    ).toThrow(
      expect.objectContaining({ name: 'CoreInputRefused', code: 'malformed', detail: 'too-deep' }),
    )
    const many = Array.from({ length: FACET_BUCKET_CHECK_CAPS.maxNodes }, () => true)
    expect(() => core.facetBucketCheck('node', { 'x.y/v0': many })).toThrow(
      expect.objectContaining({ code: 'input-too-large', detail: 'too-many' }),
    )
    const wide = 'x'.repeat(FACET_BUCKET_CHECK_CAPS.maxBytes)
    expect(() => core.facetBucketCheck('node', { 'x.y/v0': wide })).toThrow(CoreInputRefused)
  })
})
