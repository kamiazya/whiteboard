import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Core, FacetBucketResult } from '@kamiazya/whiteboard-core-wasm'
import { CoreInputRefused } from '@kamiazya/whiteboard-core-wasm'
import { loadCore } from '@kamiazya/whiteboard-core-wasm/load'
import {
  composeWorkspaceStencils,
  type FacetRegistry,
  type FacetTarget,
  firstUnrecognizedKey,
} from '@kamiazya/whiteboard-facet-engine'
import { facetEntries } from '@kamiazya/whiteboard-facet-engine/testing'
import { ReservedKeyWriteError } from '@kamiazya/whiteboard-loro-adapter'
import {
  acceptedOrThrow,
  arbitraryForSchema,
  brokenVariant,
  type Encoded,
  type EncodedIssue,
  encode,
  encodeIssues,
  fc,
  hasLoneSurrogate,
  randomFrom,
} from '@kamiazya/whiteboard-model/test-utils'
import { bundledFacetRegistry, VISUAL_STENCILS_KEY } from '@kamiazya/whiteboard-plugin-visual'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { FacetWriteRejectedError } from './errors.js'
import { partitionFacetWrites } from './facet-write.js'
import { refuseUnusableStencilLibrary } from './stencil-library.js'

/**
 * The Rust core's facet write (`facet_bucket_check`, through core-wasm's shim)
 * held to the server's own `partitionFacetWrites` and
 * `refuseUnusableStencilLibrary` over the bundled plugin: which key is
 * refused, at which stage, the path and code of every schema issue in order,
 * the stencil the library would drop, and the stored sets bit for bit with
 * their key order. The sentence of a refusal is not compared: the core words
 * none (owner decision q43).
 */

const TARGETS: readonly FacetTarget[] = ['document', 'canvas', 'node', 'edge']
const registry: FacetRegistry = bundledFacetRegistry
const deps = { facetRegistry: bundledFacetRegistry } as ServerDeps

let core: Core
beforeAll(async () => {
  const artifact = fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm'))
  core = await loadCore(readFileSync(artifact))
})

type Library = Readonly<Record<string, unknown>>
type Bucket = Record<string, unknown>

/** What the two sides are compared on. */
type Comparable =
  | { ok: true; sets: Encoded; deletions: string[] }
  | { ok: false; key: string; stage: string; detail?: unknown }

const definitionOf = (key: string) => {
  const dot = key.indexOf('.')
  const name = key.slice(dot + 1, key.indexOf('/'))
  return registry.plugins
    .find((plugin) => plugin.id === key.slice(0, dot))
    ?.facets.find((facet) => facet.name === name)
}

/** The registry a write resolves through when the workspace's library is stored. */
function registryFor(library: Library | undefined): FacetRegistry {
  return library === undefined || Object.keys(library).length === 0
    ? registry
    : composeWorkspaceStencils(registry, library as never).registry
}

const stageOfMessage = (key: string, message: string, payload: unknown): string => {
  if (message.includes('its targets are [')) return 'target'
  if (message.includes('malformed facet key')) return 'malformed-key'
  if (message.includes('is not the current version')) return 'not-current'
  if (message.includes('which no plugin registered')) return 'unregistered-asset'
  if (key === VISUAL_STENCILS_KEY && message.includes('rejected: stencil "')) return 'library'
  // The schema accepting the payload while the write is refused means a key was stripped; zod
  // words its own refusal of one the same way, so the sentence cannot tell them apart.
  return definitionOf(key)?.schema.safeParse(payload).success === true
    ? 'unrecognized-key'
    : 'invalid'
}

/** What `partitionFacetWrites` and the library refusal answer, as the core's answer is read. */
function typescript(target: FacetTarget, bucket: Bucket, library: Library | undefined): Comparable {
  const resolving = registryFor(library)
  let written: ReturnType<typeof partitionFacetWrites>
  try {
    written = partitionFacetWrites(resolving, bucket, target)
  } catch (error) {
    if (error instanceof ReservedKeyWriteError) {
      return {
        ok: false,
        key: /facet "([\s\S]*)"/.exec(error.container)?.[1] ?? '',
        stage: 'reserved-key',
      }
    }
    if (!(error instanceof FacetWriteRejectedError)) throw error
    return refusedAt(resolving, bucket, error)
  }
  try {
    refuseUnusableStencilLibrary(deps, written.sets)
  } catch (error) {
    if (!(error instanceof FacetWriteRejectedError)) throw error
    const candidate = {
      stencils: {} as Record<string, unknown>,
      ...(written.sets[VISUAL_STENCILS_KEY] as object),
    }
    const stencils = Object.entries(candidate.stencils).sort(([a], [b]) => (a < b ? -1 : 1))
    const { dropped } = composeWorkspaceStencils(registry, Object.fromEntries(stencils) as never)
    return {
      ok: false,
      key: VISUAL_STENCILS_KEY,
      stage: 'library',
      detail: dropped.map((entry) => entry.name),
    }
  }
  return { ok: true, sets: encode(written.sets), deletions: written.deletions }
}

function refusedAt(
  resolving: FacetRegistry,
  bucket: Bucket,
  error: FacetWriteRejectedError,
): Comparable {
  const key = error.facetKey
  const stage = stageOfMessage(key, error.message, bucket[key])
  const base = { ok: false as const, key, stage }
  const payload = bucket[key]
  if (stage === 'target') {
    return { ...base, detail: [...(resolving.targetsOf(key) ?? [])] }
  }
  if (stage === 'not-current') {
    const current = /write "([^"]*)"/.exec(error.message)?.[1]
    return { ...base, detail: current }
  }
  if (stage === 'invalid') {
    const result = definitionOf(key)?.schema.safeParse(payload)
    return { ...base, detail: result?.success === false ? encodeIssues(result.error.issues) : [] }
  }
  if (stage === 'unregistered-asset') {
    const found = /field (\S+) names (\w+) asset "([^"]*)".*registered: (.*)$/.exec(error.message)
    const registered = found?.[4] === '(none)' ? [] : (found?.[4] ?? '').split(', ')
    return { ...base, detail: [found?.[1], found?.[3], found?.[2], registered] }
  }
  if (stage === 'unrecognized-key') {
    const value = resolving.validateFacetWrite(key, payload)
    const stray = value.ok ? firstUnrecognizedKey(payload, value.value) : undefined
    return { ...base, detail: [stray?.path, stray?.key] }
  }
  return base
}

const issueDetail = (issue: {
  keys?: readonly string[]
  arms?: readonly (readonly unknown[])[]
  key?: readonly unknown[]
}): unknown => {
  if (issue.keys !== undefined) return { keys: [...issue.keys] }
  if (issue.arms !== undefined) return { arms: issue.arms.map((arm) => encodeCore(arm as never)) }
  if (issue.key !== undefined) return { key: encodeCore(issue.key as never) }
  return null
}

const encodeCore = (
  issues: readonly {
    path: readonly (string | number)[]
    code: string
    keys?: readonly string[]
    arms?: readonly (readonly unknown[])[]
    key?: readonly unknown[]
  }[],
): EncodedIssue[] =>
  issues.map((issue) => [[...issue.path], issue.code, issueDetail(issue)] as EncodedIssue)

/** What the core answers, read the same way, or the decline. */
function rust(
  target: FacetTarget,
  bucket: Bucket,
  library: Library | undefined,
): Comparable | 'declined' {
  let result: FacetBucketResult
  try {
    result = core.facetBucketCheck(target, bucket, library)
  } catch (error) {
    if (error instanceof CoreInputRefused) return 'declined'
    throw error
  }
  if (result.ok) return { ok: true, sets: encode(result.sets), deletions: result.deletions }
  const { key, refusal } = result
  const base = { ok: false as const, key, stage: refusal.stage }
  switch (refusal.stage) {
    case 'target':
      return { ...base, detail: [...refusal.targets] }
    case 'not-current':
      return { ...base, detail: refusal.current }
    case 'invalid':
      return { ...base, detail: encodeCore(refusal.issues) }
    case 'unregistered-asset':
      return {
        ...base,
        detail: [refusal.field, refusal.id, refusal.kind, [...refusal.registered]],
      }
    case 'unrecognized-key':
      return { ...base, detail: [[...refusal.path], refusal.key] }
    case 'library':
      return { ...base, detail: refusal.dropped.map((entry) => entry.name) }
    default:
      return base
  }
}

const tally = new Map<string, number>()
function agree(target: FacetTarget, bucket: Bucket, library?: Library): void {
  const wanted = typescript(target, bucket, library)
  const got = rust(target, bucket, library)
  expect(got, JSON.stringify({ target, bucket, library })).toEqual(wanted)
  const stage = wanted.ok ? 'ok' : wanted.stage
  tally.set(stage, (tally.get(stage) ?? 0) + 1)
}

const reservedPayload = (): object => JSON.parse('{"nested": [{"__proto__": {"a": 1}}]}') as object

/** Payloads a generator would not reach: a bound, a grammar, a unicode corner, a stripped key. */
const HAND_WRITTEN: readonly (readonly [string, unknown])[] = [
  ['visual.shape/v0', { kind: 'ellipse' }],
  ['visual.shape/v0', { kind: 'ellipse', extra: 1 }],
  ['visual.shape/v0', { kind: 'ellipse', constructor: 1, toString: 2 }],
  ['visual.shape/v0', { kind: 'ellipse', 1: 'x', '0': 'y' }],
  ['visual.shape/v0', { kind: 'rect' }],
  ['visual.shape/v0', []],
  ['visual.shape/v0', 3],
  ['visual.shape/v1', { kind: 'ellipse' }],
  ['visual.text/v0', { align: 'center', align2: 1 }],
  ['visual.theme/v0', { theme: 'visual.sketch' }],
  ['visual.theme/v0', { theme: 'visual.nothing' }],
  ['visual.stencil/v0', { stencil: 'visual.datastore' }],
  ['visual.stencil/v0', { stencil: 'workspace.mine' }],
  ['visual.stencil/v0', { stencil: 'workspace.broken' }],
  ['visual.symbol/v0', { kind: 'emoji', char: '\u{1f1ef}\u{1f1f5}' }],
  ['visual.symbol/v0', { kind: 'other', name: 'star' }],
  ['visual.symbol/v0', 'icon'],
  ['visual.tags/v0', { keys: { health: { values: { ok: { color: '3', description: 'fine' } } } } }],
  ['visual.tags/v0', { keys: { Health: {}, '7': {}, ok: { values: { 'Bad Value': {} } } } }],
  ['visual.axes/v0', { axes: Array.from({ length: 65 }, (_, i) => `a.b${i}/v0`) }],
  ['visual.edges/v0', { routing: 'curved', lineJumps: 'none', more: 1 }],
  ['visual.stencils/v0', { stencils: { ok: { displayName: 'x' } } }],
  [
    'visual.stencils/v0',
    { stencils: { ok: { displayName: 'x', facets: { 'visual.nothing/v0': {} } } } },
  ],
  [
    'visual.stencils/v0',
    { stencils: { ok: { displayName: 'x', facets: { 'visual.shape/v1': {} } } } },
  ],
  [
    'visual.stencils/v0',
    {
      stencils: {
        b: { displayName: 'x', facets: { 'visual.shape/v0': { kind: 'rect' } } },
        a: { displayName: 'y', facets: { 'visual.stencil/v0': { stencil: 'visual.nope' } } },
      },
    },
  ],
  ['visual.stencils/v0', { stencils: { Bad: { displayName: 'x' } } }],
  ['visual.stencils/v0', { stencils: { 7: { displayName: 'x' }, 1: 5 } }],
  ['visual.nothing/v0', { anything: [1, 2.5, -0, 1e300, 5e-324, Number.MAX_SAFE_INTEGER + 2] }],
  ['x.y/v0', { '2': 'b', '1': 'a', z: 0, a: { '10': 1, '9': 2 } }],
  ['x.y/v0', [{ nested: [[], {}] }]],
  ['x.y/v0', -0],
  ['x.y/v0', '\u{1f600} text'],
  ['x.y/v0', { hasOwnProperty: 1, valueOf: 2 }],
  ['', null],
  ['nope', 1],
  ['Visual.shape/v0', {}],
  ['visual.shape/v0\n', {}],
  ['5', 1],
]

const LIBRARIES: readonly (Library | undefined)[] = [
  undefined,
  {},
  { mine: { displayName: 'Mine' } },
  { mine: { displayName: 'Mine' }, broken: { displayName: '' } },
  { broken: { displayName: 'B', facets: { 'visual.shape/v0': { kind: 'rect' } } } },
  {
    mine: { displayName: 'M', color: '#abcdef' },
    other: { displayName: 'O', facets: { 'visual.shape/v0': { kind: 'ellipse' } } },
  },
  { Bad: { displayName: 'x' }, mine: { displayName: 'Mine' } },
]

describe('the facet write over the Rust core, held to partitionFacetWrites', () => {
  it('agrees on every hand-written payload, at every target, over each stored library', () => {
    for (const [key, payload] of HAND_WRITTEN) {
      for (const target of TARGETS) {
        for (const library of LIBRARIES) {
          if (hasLoneSurrogate(payload)) continue
          agree(target, { [key]: payload }, library)
        }
      }
    }
  })

  it('agrees on a payload for every registered facet, valid and broken', () => {
    const entries = TARGETS.flatMap((target) =>
      facetEntries(registry, target).map((entry) => [target, entry] as const),
    )
    expect(entries.length).toBeGreaterThan(10)
    for (const [target, entry] of entries) {
      const refs = new Map<string, fc.Arbitrary<unknown>>()
      for (const [field, kind] of Object.entries(entry.assetRefs ?? {})) {
        refs.set(`$.${field}`, fc.constantFrom(...registry.assetIds(kind)))
      }
      const arbitrary = acceptedOrThrow(
        arbitraryForSchema(entry.schema, { override: (path) => refs.get(path) }),
        (payload) => {
          const result = registry.validateFacetWrite(entry.key, payload)
          return result.ok ? undefined : result.message
        },
        entry.key,
      )
      const valid = fc.sample(arbitrary, { numRuns: 40 }).filter((draw) => !hasLoneSurrogate(draw))
      const seeds = fc.sample(fc.integer({ min: 0, max: 2 ** 31 - 1 }), 40)
      for (const [index, payload] of valid.entries()) {
        const broken = brokenVariant(payload, randomFrom(seeds[index] ?? 0))
        const stray =
          typeof payload === 'object' && payload !== null && !Array.isArray(payload)
            ? { ...payload, zz_stray: 1 }
            : payload
        for (const candidate of [payload, broken, stray]) {
          if (!hasLoneSurrogate(candidate)) agree(target, { [entry.key]: candidate })
        }
      }
    }
  })

  it('agrees on buckets that mix keys, deletions and a reserved key, in the order the server walks them', () => {
    const keys = [
      ...HAND_WRITTEN.map(([key]) => key),
      'visual.text/v0',
      'visual.edges/v0',
      'visual.ink/v0',
      'visual.axes/v0',
    ]
    const payloads = HAND_WRITTEN.map(([, payload]) => payload).filter((p) => !hasLoneSurrogate(p))
    const entry = fc.tuple(
      fc.constantFrom(...keys),
      fc.oneof(
        { weight: 6, arbitrary: fc.constantFrom(...payloads) },
        { weight: 3, arbitrary: fc.constant(null) },
        { weight: 1, arbitrary: fc.constant('reserved') },
      ),
    )
    fc.assert(
      fc.property(
        fc.array(entry, { minLength: 1, maxLength: 5 }),
        fc.constantFrom(...TARGETS),
        fc.constantFrom(...LIBRARIES),
        (entries, target, library) => {
          const bucket: Bucket = {}
          for (const [key, payload] of entries)
            bucket[key] = payload === 'reserved' ? reservedPayload() : payload
          agree(target, bucket, library)
        },
      ),
      { numRuns: 400 },
    )
  })

  it('reaches every stage the write can refuse at, and accepts', () => {
    for (const stage of [
      'ok',
      'target',
      'malformed-key',
      'not-current',
      'invalid',
      'unregistered-asset',
      'unrecognized-key',
      'library',
      'reserved-key',
    ]) {
      expect(tally.get(stage) ?? 0, stage).toBeGreaterThan(5)
    }
  })

  it('declines an undefined where the TypeScript reads an absent key, which it would have accepted', () => {
    const bucket = { 'visual.shape/v0': { kind: 'ellipse', extra: undefined } }
    expect(typescript('node', bucket, undefined)).toMatchObject({ ok: true })
    expect(rust('node', bucket, undefined)).toBe('declined')
    expect(rust('node', { 'visual.shape/v0': undefined }, undefined)).toBe('declined')
  })
})
