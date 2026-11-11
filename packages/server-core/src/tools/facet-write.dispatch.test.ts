import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type Core, CoreInputRefused } from '@kamiazya/whiteboard-core-wasm'
import { loadCore } from '@kamiazya/whiteboard-core-wasm/load'
import { ReservedKeyWriteError } from '@kamiazya/whiteboard-loro-adapter'
import { VISUAL_STENCILS_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { facetWriteCoreInstalled, installFacetWriteCore } from '../facet-write-core.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { FacetWriteRejectedError } from './errors.js'
import { facetWriterFor } from './facet-write.js'

/**
 * The facet write over the realm's Rust core: what a writer answers, what it
 * sends the core, what it does with a call the core declines, and what a realm
 * with no core does. The core is the real artifact, wrapped where a test needs
 * to see what it was asked.
 */

let core: Core
beforeAll(async () => {
  const artifact = fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm'))
  core = await loadCore(readFileSync(artifact))
})

// The realm's core is process-global; a test that swaps it puts it back.
const realm = installFacetWriteCore(undefined)
installFacetWriteCore(realm)
afterEach(() => installFacetWriteCore(realm))

type FacetWriteCore = NonNullable<Parameters<typeof installFacetWriteCore>[0]>

interface Harness {
  readonly calls: { library: unknown }[]
  readonly write: (bucket: Record<string, unknown>, target?: 'node' | 'document') => unknown
}

async function harness(
  decline = false,
  buckets: readonly Record<string, unknown>[] = [],
): Promise<Harness> {
  const calls: { library: unknown }[] = []
  const wrapped: FacetWriteCore = {
    facetBucketCheck(target, bucket, library) {
      calls.push({ library })
      if (decline) throw new CoreInputRefused('facet_bucket_check', 'input-too-large')
      return core.facetBucketCheck(target, bucket, library)
    },
  }
  installFacetWriteCore(wrapped)
  const writer = await facetWriterFor(makeTestDeps(), 'ws', buckets as never)
  const write = (bucket: Record<string, unknown>, target: 'node' | 'document' = 'node') => {
    try {
      return writer.write(bucket as never, target)
    } catch (error) {
      return error
    }
  }
  return { calls, write }
}

const GOOD: Record<string, unknown> = {
  'visual.shape/v0': { kind: 'ellipse' },
  'visual.text/v0': null,
}
const BAD_TARGET: Record<string, unknown> = { 'visual.theme/v0': { theme: 'visual.sketch' } }
const BAD_PAYLOAD: Record<string, unknown> = { 'visual.shape/v0': { kind: 'nope' } }

describe('the facet write over the realm core', () => {
  it('answers the sets and deletions the core judges', async () => {
    const h = await harness()
    expect(h.write(GOOD)).toEqual({
      sets: { 'visual.shape/v0': { kind: 'ellipse' } },
      deletions: ['visual.text/v0'],
    })
    expect(h.calls).toHaveLength(1)
  })

  it('refuses in the classes a writer answers a refusal in', async () => {
    const h = await harness()
    expect(h.write(BAD_TARGET)).toBeInstanceOf(FacetWriteRejectedError)
    expect(h.write(BAD_PAYLOAD)).toBeInstanceOf(FacetWriteRejectedError)
    const reserved = h.write({ 'x.y/v0': JSON.parse('{"__proto__": {"a": 1}}') })
    expect(reserved).toBeInstanceOf(ReservedKeyWriteError)
  })

  it('names the facet, the field path and the issue code of a payload the core refuses', async () => {
    const h = await harness()
    expect((h.write(BAD_PAYLOAD) as Error).message).toMatch(
      /facet "visual\.shape\/v0" rejected: payload for "visual\.shape\/v0" is invalid: kind: \w+/,
    )
  })

  it('sends the stored library only with a write that names a stencil', async () => {
    const stencil = { 'visual.stencil/v0': { stencil: 'visual.datastore' } }
    const h = await harness(false, [stencil])
    h.write(GOOD)
    h.write(stencil)
    expect(h.calls.map((call) => call.library === undefined)).toEqual([true, false])
  })

  it('names the stencil, the facet it carries and why the core would drop it', async () => {
    const h = await harness()
    const library = (facets: Record<string, unknown>) => ({
      [VISUAL_STENCILS_KEY]: { stencils: { worse: { displayName: 'W', facets } } },
    })
    const message = (facets: Record<string, unknown>) =>
      (h.write(library(facets), 'document') as Error).message
    expect(message({ 'visual.shape/v0': { kind: 'blob' } })).toMatch(
      /stencil "worse": its "visual\.shape\/v0" payload is invalid: kind: \w+/,
    )
    expect(message({ 'nope.nothing/v0': {} })).toMatch(
      /stencil "worse": it carries "nope\.nothing\/v0", which no plugin registered/,
    )
  })

  it('refuses a write the core declines, naming the facet and the core as the reason', async () => {
    const h = await harness(true)
    const refused = h.write(BAD_PAYLOAD)
    expect(refused).toBeInstanceOf(FacetWriteRejectedError)
    expect((refused as FacetWriteRejectedError).facetKey).toBe('visual.shape/v0')
    expect((refused as Error).message).toMatch(/the Rust core declined this write.*input-too-large/)
    // A good bucket is refused too: no second implementation answers in the core's place.
    expect(h.write(GOOD)).toBeInstanceOf(FacetWriteRejectedError)
  })

  it('refuses a payload the core wire cannot carry, rather than storing what it cannot judge', async () => {
    const h = await harness()
    const refused = h.write({ 'visual.shape/v0': { kind: 'ellipse', extra: undefined } })
    expect(refused).toBeInstanceOf(FacetWriteRejectedError)
    expect((refused as Error).message).toMatch(/the Rust core declined/)
  })

  it('lets any other failure of the core through, never as a refusal', async () => {
    installFacetWriteCore({
      facetBucketCheck() {
        throw new TypeError('wasm trapped')
      },
    })
    const writer = await facetWriterFor(makeTestDeps(), 'ws', [])
    expect(() => writer.write(GOOD as never, 'node')).toThrow(TypeError)
  })
})

describe('a realm that installed no core', () => {
  it('fails by name, naming the install function, instead of judging in another way', async () => {
    installFacetWriteCore(undefined)
    expect(facetWriteCoreInstalled()).toBe(false)
    await expect(facetWriterFor(makeTestDeps(), 'ws', [])).rejects.toMatchObject({
      name: 'FacetWriteCoreNotInstalled',
    })
    await expect(facetWriterFor(makeTestDeps(), 'ws', [])).rejects.toThrow(
      /before this realm installed the Rust core.*installFacetWriteCore/,
    )
  })
})
