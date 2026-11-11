import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type Core, CoreInputRefused } from '@kamiazya/whiteboard-core-wasm'
import { loadCore } from '@kamiazya/whiteboard-core-wasm/load'
import { ReservedKeyWriteError } from '@kamiazya/whiteboard-loro-adapter'
import { beforeAll, describe, expect, it } from 'vitest'
import type {
  FacetWriteCore,
  FacetWriteJudgement,
  FacetWriteMismatch,
} from '../facet-write-core.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { FacetWriteRejectedError } from './errors.js'
import { facetWriterFor } from './facet-write.js'

/**
 * The facet write's switch: what each impl answers, what `differential`
 * holds the two equal on, and what a declined call does. The core is the real
 * artifact, wrapped where a test needs it to answer something else.
 */

let core: Core
beforeAll(async () => {
  const artifact = fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm'))
  core = await loadCore(readFileSync(artifact))
})

interface Harness {
  readonly mismatches: FacetWriteMismatch[]
  readonly calls: { library: unknown }[]
  readonly write: (bucket: Record<string, unknown>, target?: 'node' | 'document') => unknown
}

async function harness(
  impl: FacetWriteCore['impl']['partitionFacetWrites'],
  wrap: (answer: FacetWriteJudgement) => FacetWriteJudgement = (answer) => answer,
  decline = false,
  buckets: readonly Record<string, unknown>[] = [],
): Promise<Harness> {
  const mismatches: FacetWriteMismatch[] = []
  const calls: { library: unknown }[] = []
  const facets: FacetWriteCore['facets'] = {
    facetBucketCheck(target, bucket, library) {
      calls.push({ library })
      if (decline) throw new CoreInputRefused('facet_bucket_check', 'input-too-large')
      return wrap(core.facetBucketCheck(target, bucket, library))
    },
  }
  const facetWriteCore: FacetWriteCore = {
    facets,
    impl: { partitionFacetWrites: impl },
    onMismatch: (mismatch) => mismatches.push(mismatch),
  }
  const writer = await facetWriterFor(
    makeTestDeps({ facetWriteCore: async () => facetWriteCore }),
    'ws',
    buckets as never,
  )
  const write = (bucket: Record<string, unknown>, target: 'node' | 'document' = 'node') => {
    try {
      return writer.write(bucket as never, target)
    } catch (error) {
      return error
    }
  }
  return { mismatches, calls, write }
}

const GOOD: Record<string, unknown> = {
  'visual.shape/v0': { kind: 'ellipse' },
  'visual.text/v0': null,
}
const BAD_TARGET: Record<string, unknown> = { 'visual.theme/v0': { theme: 'visual.sketch' } }
const BAD_PAYLOAD: Record<string, unknown> = { 'visual.shape/v0': { kind: 'nope' } }

describe('the facet write switch', () => {
  it('never asks the core under ts', async () => {
    const h = await harness('ts')
    expect(h.write(GOOD)).toEqual({
      sets: { 'visual.shape/v0': { kind: 'ellipse' } },
      deletions: ['visual.text/v0'],
    })
    expect(h.calls).toEqual([])
  })

  it('answers with the core under rust, and refuses in the classes the TypeScript refuses in', async () => {
    const h = await harness('rust')
    expect(h.write(GOOD)).toEqual({
      sets: { 'visual.shape/v0': { kind: 'ellipse' } },
      deletions: ['visual.text/v0'],
    })
    expect(h.write(BAD_TARGET)).toBeInstanceOf(FacetWriteRejectedError)
    expect(h.write(BAD_PAYLOAD)).toBeInstanceOf(FacetWriteRejectedError)
    const reserved = h.write({ 'x.y/v0': JSON.parse('{"__proto__": {"a": 1}}') })
    expect(reserved).toBeInstanceOf(ReservedKeyWriteError)
    expect(h.mismatches).toEqual([])
  })

  it('reports nothing under differential when the two agree, and answers from the TypeScript', async () => {
    const h = await harness('differential')
    for (const bucket of [GOOD, BAD_TARGET, BAD_PAYLOAD]) h.write(bucket)
    expect(h.calls).toHaveLength(3)
    expect(h.mismatches).toEqual([])
  })

  it('sends the stored library only with a write that names a stencil', async () => {
    const stencil = { 'visual.stencil/v0': { stencil: 'visual.datastore' } }
    const h = await harness('rust', undefined, false, [stencil])
    h.write(GOOD)
    h.write(stencil)
    expect(h.calls.map((call) => call.library === undefined)).toEqual([true, false])
  })

  describe('a difference is reported when', () => {
    const differs = async (
      wrap: (answer: FacetWriteJudgement) => FacetWriteJudgement,
      bucket = GOOD,
    ) => {
      const h = await harness('differential', wrap)
      const answered = h.write(bucket)
      return { answered, mismatches: h.mismatches }
    }

    it('a stored value differs by a bit', async () => {
      const { mismatches, answered } = await differs((answer) =>
        answer.ok ? { ...answer, sets: { 'visual.shape/v0': { kind: 'rect' } } } : answer,
      )
      expect(mismatches.map((m) => m.kind)).toEqual(['differs'])
      expect(answered).toEqual({
        sets: { 'visual.shape/v0': { kind: 'ellipse' } },
        deletions: ['visual.text/v0'],
      })
    })

    it('the sets hold the same keys in another order', async () => {
      const bucket = {
        'visual.shape/v0': { kind: 'ellipse' },
        'visual.text/v0': { align: 'center' },
      }
      const { mismatches } = await differs(
        (answer) =>
          answer.ok
            ? { ...answer, sets: Object.fromEntries(Object.entries(answer.sets).reverse()) }
            : answer,
        bucket,
      )
      expect(mismatches).toHaveLength(1)
    })

    it('a refusal names another stage', async () => {
      const { mismatches } = await differs(
        (answer) => (answer.ok ? answer : { ...answer, refusal: { stage: 'malformed-key' } }),
        BAD_TARGET,
      )
      expect(mismatches).toHaveLength(1)
    })

    it('a refusal names another key', async () => {
      const { mismatches } = await differs(
        (answer) => (answer.ok ? answer : { ...answer, key: 'visual.other/v0' }),
        BAD_TARGET,
      )
      expect(mismatches).toHaveLength(1)
    })

    it('an issue carries another code', async () => {
      const { mismatches } = await differs(
        (answer) =>
          !answer.ok && answer.refusal.stage === 'invalid'
            ? {
                ...answer,
                refusal: {
                  stage: 'invalid',
                  issues: answer.refusal.issues.map((issue) => ({ ...issue, code: 'custom' })),
                },
              }
            : answer,
        BAD_PAYLOAD,
      )
      expect(mismatches).toHaveLength(1)
    })

    it('an issue is at another path', async () => {
      const { mismatches } = await differs(
        (answer) =>
          !answer.ok && answer.refusal.stage === 'invalid'
            ? {
                ...answer,
                refusal: {
                  stage: 'invalid',
                  issues: answer.refusal.issues.map((issue) => ({ ...issue, path: ['elsewhere'] })),
                },
              }
            : answer,
        BAD_PAYLOAD,
      )
      expect(mismatches).toHaveLength(1)
    })

    it('the core accepts what the TypeScript refuses', async () => {
      const { mismatches, answered } = await differs(
        () => ({ ok: true, sets: {}, deletions: [] }),
        BAD_PAYLOAD,
      )
      expect(mismatches).toHaveLength(1)
      expect(answered).toBeInstanceOf(FacetWriteRejectedError)
    })
  })

  it('is not a difference when only the words of a refusal differ', async () => {
    const h = await harness('differential', (answer) => ({ ...answer }))
    h.write(BAD_PAYLOAD)
    expect(h.mismatches).toEqual([])
  })

  it.each([
    'differential',
    'rust',
  ] as const)('answers from the TypeScript and reports a decline under %s', async (impl) => {
    const h = await harness(impl, undefined, true)
    expect(h.write(BAD_PAYLOAD)).toBeInstanceOf(FacetWriteRejectedError)
    expect(h.write(GOOD)).toEqual({
      sets: { 'visual.shape/v0': { kind: 'ellipse' } },
      deletions: ['visual.text/v0'],
    })
    expect(h.mismatches.map((m) => m.kind)).toEqual(['declined', 'declined'])
  })
})
