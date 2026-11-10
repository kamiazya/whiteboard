/**
 * The write path of the bundled registry, recorded for the Rust registry to
 * replay (`crates/core/plugin-visual/tests/facet_write_oracle.rs`): per facet
 * about a hundred payloads it accepts and as many it refuses, a refusal at
 * each stage `validateFacetWrite` has (key grammar, version, schema, asset),
 * and the declarations a caller asks of the registry beside it.
 *
 * Inputs are drawn from the registry's own schemas, so a facet registered
 * later is recorded without anyone naming it; the committed recording is what
 * the Rust side and the replaying test hold to, and is regenerated only on
 * purpose (`WHITEBOARD_RECORD_ORACLE=1`).
 */
import type { AssetKind, FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import {
  brokenVariant,
  decode,
  type Encoded,
  type EncodedIssue,
  encode,
  encodeIssues,
  facetEntries,
  hasLoneSurrogate,
  randomFrom,
} from '@kamiazya/whiteboard-facet-engine/testing'
import { acceptedOrThrow, arbitraryForSchema } from '@kamiazya/whiteboard-model/test-utils'
import { fc } from './fast-check.js'

const KINDS: readonly AssetKind[] = ['themes', 'icons', 'stencils']
const TARGETS = ['document', 'canvas', 'node', 'edge'] as const

export type WriteAnswer =
  | { ok: Encoded }
  | { err: { stage: 'key' } }
  | { err: { stage: 'version'; current: string } }
  | { err: { stage: 'schema'; issues: EncodedIssue[] } }
  | { err: { stage: 'asset'; field: string; id: string; kind: AssetKind } }

export type RecordedLine =
  | { k: 'h'; assets: Record<AssetKind, readonly string[]> }
  | {
      k: 't'
      key: string
      targets: readonly string[] | null
      refs: readonly (readonly [string, AssetKind])[]
    }
  | ({ k: 'w'; key: string; in: Encoded } & WriteAnswer)

const KEY_GRAMMAR = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\/v[0-9]+$/

function registeredKeys(registry: FacetRegistry): string[] {
  return registry.plugins.flatMap((plugin) =>
    plugin.facets.map((facet) => `${plugin.id}.${facet.name}/${facet.version}`),
  )
}

function definitionOf(registry: FacetRegistry, key: string) {
  const dot = key.indexOf('.')
  const name = key.slice(dot + 1, key.indexOf('/'))
  return registry.plugins
    .find((plugin) => plugin.id === key.slice(0, dot))
    ?.facets.find((facet) => facet.name === name)
}

/**
 * What `validateFacetWrite` answers, with the issues of a schema refusal kept
 * as data. The stage is cross-checked against the registry's own verdict by
 * the caller, so this walk cannot drift from the function it records.
 */
export function answerWrite(registry: FacetRegistry, key: string, payload: unknown): WriteAnswer {
  if (!KEY_GRAMMAR.test(key)) return { err: { stage: 'key' } }
  const definition = definitionOf(registry, key)
  if (definition === undefined) return { ok: encode(payload) }
  const current = `${key.slice(0, key.indexOf('/'))}/${definition.version}`
  if (key !== current) return { err: { stage: 'version', current } }
  const result = definition.schema.safeParse(payload)
  if (!result.success) {
    return { err: { stage: 'schema', issues: encodeIssues(result.error.issues) } }
  }
  const data = result.data as Record<string, unknown> | null
  for (const [field, kind] of Object.entries(definition.assetRefs ?? {})) {
    const id = typeof data === 'object' && data !== null ? data[field] : undefined
    if (typeof id === 'string' && !registry.assetIds(kind).includes(id)) {
      return { err: { stage: 'asset', field, id, kind } }
    }
  }
  return { ok: encode(result.data) }
}

/** The stage a `validateFacetWrite` message names, which `answerWrite` must agree with. */
export function stageOfMessage(message: string): 'key' | 'version' | 'schema' | 'asset' {
  if (message.startsWith('malformed facet key')) return 'key'
  if (message.includes('is not the current version')) return 'version'
  if (message.includes('which no plugin registered')) return 'asset'
  return 'schema'
}

export function headerLine(registry: FacetRegistry): RecordedLine {
  const assets = Object.fromEntries(KINDS.map((kind) => [kind, registry.assetIds(kind)]))
  return { k: 'h', assets: assets as Record<AssetKind, readonly string[]> }
}

export function declarationLines(registry: FacetRegistry): RecordedLine[] {
  const keys = [
    ...registeredKeys(registry),
    'visual.nothing/v0',
    'other.shape/v0',
    'visual.shape/v1',
    'nope',
  ]
  return keys.map((key) => ({
    k: 't',
    key,
    targets: registry.targetsOf(key) ?? null,
    refs: Object.entries(registry.assetRefsOf(key) ?? {}) as [string, AssetKind][],
  }))
}

/** A payload the registry accepts for `key`, drawn from the facet's own schema. */
function validDraws(registry: FacetRegistry, key: string, count: number): unknown[] {
  const entry = TARGETS.flatMap((target) => facetEntries(registry, target)).find(
    (found) => found.key === key,
  )
  if (entry === undefined) throw new Error(`no facet ${key}`)
  const refs = new Map<string, fc.Arbitrary<unknown>>()
  for (const [field, kind] of Object.entries(entry.assetRefs ?? {})) {
    refs.set(`$.${field}`, fc.constantFrom(...registry.assetIds(kind)))
  }
  const arbitrary = acceptedOrThrow(
    arbitraryForSchema(entry.schema, { override: (path) => refs.get(path) }),
    (payload) => {
      const result = registry.validateFacetWrite(key, payload)
      return result.ok ? undefined : result.message
    },
    key,
  )
  return fc.sample(arbitrary, { numRuns: count }).filter((draw) => !hasLoneSurrogate(draw))
}

const stencils = (count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `s${i.toString(36)}`,
      { displayName: `Stencil ${i}` },
    ]),
  )

/** Payloads the generator would not reach: a bound, a grammar, a unicode corner. */
const HAND_WRITTEN: readonly (readonly [string, unknown])[] = [
  ['visual.stencils/v0', { stencils: stencils(256) }],
  ['visual.stencils/v0', { stencils: stencils(257) }],
  ['visual.stencils/v0', { stencils: { ...stencils(257), BAD: 1 } }],
  ['visual.stencils/v0', { stencils: { Bad: { displayName: 'x' } } }],
  ['visual.stencils/v0', { stencils: { ok: { displayName: '' } } }],
  ['visual.stencils/v0', { stencils: { ok: { displayName: 'x', color: 'red' } } }],
  ['visual.stencils/v0', { stencils: { ok: { displayName: 'x', color: '' } } }],
  ['visual.stencils/v0', { stencils: { ok: { displayName: 'x', color: '#aabbcc', extra: 1 } } }],
  [
    'visual.stencils/v0',
    { stencils: { ok: { displayName: 'x', facets: { 'visual.shape/v0': { kind: 'ellipse' } } } } },
  ],
  [
    'visual.stencils/v0',
    { stencils: { ok: { displayName: 'x', facets: { Bad: 1, 'a.b/v0': null } } } },
  ],
  ['visual.stencils/v0', { stencils: { '7': { displayName: 'x' }, '1': 5 } }],
  ['visual.axes/v0', { axes: Array.from({ length: 64 }, (_, i) => `a.b${i}/v0`) }],
  ['visual.axes/v0', { axes: Array.from({ length: 65 }, (_, i) => `a.b${i}/v0`) }],
  [
    'visual.axes/v0',
    { axes: Array.from({ length: 66 }, (_, i) => (i % 2 ? 'bad' : `a.b${i}/v0`)) },
  ],
  ['visual.axes/v0', { axes: ['a.b/v0', 'a.b/v0\n', 3] }],
  ['visual.axes/v0', { axes: 'a.b/v0' }],
  ['visual.axes/v0', { axes: 'x'.repeat(70) }],
  ['visual.axes/v0', { axes: { length: 70 } }],
  ['visual.axes/v0', { axes: [] }],
  ['visual.ink/v0', { group: [] }],
  ['visual.ink/v0', { group: { length: 0 } }],
  ['visual.symbol/v0', { kind: 'emoji', char: '' }],
  ['visual.symbol/v0', { kind: 'emoji', char: 'ab' }],
  ['visual.symbol/v0', { kind: 'emoji', char: '\u{1f1ef}\u{1f1f5}' }],
  ['visual.symbol/v0', { kind: 'emoji', char: 'é' }],
  ['visual.symbol/v0', { kind: 'emoji' }],
  ['visual.symbol/v0', { kind: 'icon', name: '' }],
  ['visual.symbol/v0', { kind: 'icon', name: 'star', extra: true }],
  ['visual.symbol/v0', { kind: 'other', name: 'star' }],
  ['visual.symbol/v0', { char: 'x' }],
  ['visual.symbol/v0', {}],
  ['visual.symbol/v0', 'icon'],
  ['visual.symbol/v0', null],
  ['visual.tags/v0', { keys: { health: { values: { ok: { color: 'red' } } } } }],
  ['visual.tags/v0', { keys: { health: { values: { ok: { color: '3', description: 'fine' } } } } }],
  ['visual.tags/v0', { keys: { health: { values: { ok: { color: '#ABCDEF' } } } } }],
  ['visual.tags/v0', { keys: { health: { values: { ok: { color: 7 } } } } }],
  ['visual.tags/v0', { keys: { health: { exclusive: 'yes' } } }],
  ['visual.tags/v0', { keys: { Health: {}, '7': {}, ok: { values: { 'Bad Value': {} } } } }],
  ['visual.tags/v0', { keys: { health: { values: { ok: { extra: 1 } } }, other: { extra: 1 } } }],
  ['visual.theme/v0', { theme: 'visual.nothing' }],
  ['visual.theme/v0', { theme: 'nothing' }],
  ['visual.theme/v0', { theme: 3 }],
  ['visual.stencil/v0', { stencil: 'visual.nothing' }],
  ['visual.stencil/v0', { stencil: 'Visual.thing' }],
  ['visual.stencil/v0', { stencil: 'visual.thing', extra: 1 }],
  ['visual.shape/v0', { kind: 'rect' }],
  ['visual.shape/v0', { kind: 'ellipse', 1: 'x', '0': 'y' }],
  ['visual.edges/v0', { routing: 'zigzag', lineJumps: 'arc' }],
  ['visual.edges/v0', { routing: 'curved', lineJumps: 'none', more: 1 }],
  ['visual.edges/v0', {}],
  ['visual.edges/v0', []],
  ['visual.ink/v0', { group: '' }],
  ['visual.ink/v0', { group: 'g', 3: 4 }],
  ['visual.stroke/v0', { width: 'thin' }],
  ['visual.text/v0', { align: 'end' }],
  ['visual.text/v0', { align: 'center', align2: 1 }],
]

/** Keys and payloads that never reach a schema. */
const KEY_STAGE: readonly (readonly [string, unknown])[] = [
  ['', null],
  ['visual', 1],
  ['visual.shape', { kind: 'ellipse' }],
  ['visual.shape/v', { kind: 'ellipse' }],
  ['Visual.shape/v0', { kind: 'ellipse' }],
  ['visual.shape/v0\n', { kind: 'ellipse' }],
  ['visual.shape/V0', {}],
  ['a.b.c/v0', {}],
  ['visual.shape/v1', { kind: 'ellipse' }],
  ['visual.shape/v00', { kind: 'ellipse' }],
  ['visual.stencils/v2', {}],
  ['visual.theme/v7', { theme: 'visual.sketch' }],
  ['other.facet/v0', { anything: [1, 2.5, -0, 1e300, 5e-324, Number.MAX_SAFE_INTEGER + 2] }],
  ['other.facet/v3', 'a string'],
  ['visual.unknown/v0', null],
  ['visual.unknown/v0', { '2': 'b', '1': 'a', z: 0, a: { '10': 1, '9': 2 } }],
  ['x.y/v0', []],
  ['x.y/v0', [{ nested: [[], {}] }]],
  ['x.y/v0', true],
  ['x.y/v0', -0],
  ['x.y/v0', 0.1],
  ['x.y/v0', 1e21],
  ['x.y/v0', '\u{1f600} text'],
  ['x.y/v0', ''],
  ['w.w/v1', { 'visual.shape/v0': { kind: 'ellipse', extra: 1 } }],
  ['visual-b.shape/v0', {}],
  ['a-b.c-d/v12', { deep: { deeper: { deepest: [1, { k: 'v' }] } } }],
  ['visual.shape/v0', { kind: 'ellipse', extra: 1 }],
  ['visual.shape/v0', null],
  ['visual.shape/v0', []],
  ['visual.shape/v0', 'ellipse'],
  ['visual.shape/v0', 3],
  ['visual.shape/v0', {}],
  ['visual.shape/v0', { kind: 'ellipse', 3: 'x', 1: 'y' }],
  ['visual.shape/v0', { kind: ['ellipse'] }],
  ['visual.shape/v0', { kind: null }],
  ['visual.shape/v0', { kind: 'Ellipse' }],
  ['visual.theme/v0', { theme: 'visual.sketch' }],
  ['visual.theme/v0', { theme: 'visual.neon' }],
  ...['edges', 'ink', 'tags', 'stroke', 'text', 'axes', 'symbol', 'stencil'].map(
    (name, i) => [`visual.${name}/v${i + 1}`, { any: i }] as const,
  ),
  ...['other.theme', 'a-b.c-d', 'visual.sketch2', 'visual.Sketch'].flatMap((id) => [
    ['visual.theme/v0', { theme: id }] as const,
    ['visual.stencil/v0', { stencil: id, extra: 'stripped' }] as const,
  ]),
]

const VALID_PER_FACET = 120
const BROKEN_PER_FACET = 120

function lineFor(registry: FacetRegistry, key: string, payload: unknown): RecordedLine {
  const answer = answerWrite(registry, key, payload)
  const verdict = registry.validateFacetWrite(key, payload)
  const stage = 'ok' in answer ? null : answer.err.stage
  if (verdict.ok !== 'ok' in answer || (!verdict.ok && stageOfMessage(verdict.message) !== stage)) {
    throw new Error(`the recorder and validateFacetWrite disagree about ${key}`)
  }
  return { k: 'w', key, in: encode(payload), ...answer }
}

/** The whole recording, drawn fresh: only a deliberate re-recording calls this. */
export function recordLines(registry: FacetRegistry): RecordedLine[] {
  const lines: RecordedLine[] = [headerLine(registry), ...declarationLines(registry)]
  for (const key of registeredKeys(registry)) {
    const valid = validDraws(registry, key, VALID_PER_FACET)
    const seeds = fc.sample(fc.integer({ min: 0, max: 2 ** 31 - 1 }), BROKEN_PER_FACET)
    const broken = seeds.map((seed, i) =>
      brokenVariant(valid[i % Math.max(valid.length, 1)] ?? {}, randomFrom(seed)),
    )
    for (const payload of [...valid, ...broken]) {
      if (!hasLoneSurrogate(payload)) lines.push(lineFor(registry, key, payload))
    }
  }
  for (const [key, payload] of [...HAND_WRITTEN, ...KEY_STAGE])
    lines.push(lineFor(registry, key, payload))
  return lines
}

/** The answer a recorded line stands for, asked of today's registry. */
export function answerAgain(registry: FacetRegistry, line: RecordedLine): RecordedLine {
  if (line.k === 'h') return headerLine(registry)
  if (line.k === 't') {
    return declarationLines(registry).find((c) => c.k === 't' && c.key === line.key) ?? line
  }
  return { k: 'w', key: line.key, in: line.in, ...answerWrite(registry, line.key, decode(line.in)) }
}
