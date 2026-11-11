import { describe, expect, it } from 'vitest'
import { FACET_BUCKET_CHECK_CAPS } from './generated/input-caps.js'
import { type CoreGlue, CoreInputRefused, coreFrom, EXPECTED_ABI } from './index.js'

/** A core over a glue that answers `answer` to a bucket check and records what it was sent. */
function coreAnswering(answer: unknown) {
  const sent: string[][] = []
  const raw = typeof answer === 'string' ? answer : JSON.stringify(answer)
  const glue: CoreGlue = {
    initSync: () => undefined,
    abi_version: () => EXPECTED_ABI,
    edge_route_layout: () => new Float64Array(),
    okf_parse: () => '',
    okf_serialize: () => '',
    json_canvas_parse: () => '',
    json_canvas_serialize: () => '',
    facet_bucket_check: (target, bucket, library) => {
      sent.push([target, bucket, library])
      return raw
    },
  }
  return { core: coreFrom(glue, new Uint8Array()), sent }
}

const refusedWith = (
  answer: unknown,
  run: (core: ReturnType<typeof coreAnswering>['core']) => unknown,
) => expect(() => run(coreAnswering(answer).core))

describe('the facet write shim', () => {
  it('sends the target, the bucket in enumeration order and the library as the value wire', () => {
    const { core, sent } = coreAnswering(['ok', ['m'], ['s']])
    core.facetBucketCheck(
      'node',
      { b: { n: 1, flag: true }, '2': null, a: [-0, 'x'] },
      { mine: { displayName: 'Mine' } },
    )
    expect(sent).toEqual([
      [
        'node',
        JSON.stringify([
          'm',
          '2',
          null,
          'b',
          ['m', 'n', ['f', '3ff0000000000000'], 'flag', true],
          'a',
          ['s', ['f', '8000000000000000'], 'x'],
        ]),
        JSON.stringify(['m', 'mine', ['m', 'displayName', 'Mine']]),
      ],
    ])
  })

  it('answers the stored sets as the objects a host holds, keeping bits, and the deletions', () => {
    const { core } = coreAnswering([
      'ok',
      ['m', 'a.b/v0', ['m', 'x', ['f', '8000000000000000'], 'y', ['s', true, null]]],
      ['s', 'c.d/v0'],
    ])
    const result = core.facetBucketCheck('node', { 'a.b/v0': {}, 'c.d/v0': null })
    expect(result).toEqual({
      ok: true,
      sets: { 'a.b/v0': { x: -0, y: [true, null] } },
      deletions: ['c.d/v0'],
    })
    if (result.ok) expect(Object.is((result.sets['a.b/v0'] as { x: number }).x, -0)).toBe(true)
  })

  it('judges nothing when the bucket is absent or empty', () => {
    const { core, sent } = coreAnswering('not called')
    expect(core.facetBucketCheck('node', undefined)).toEqual({ ok: true, sets: {}, deletions: [] })
    expect(core.facetBucketCheck('node', {})).toEqual({ ok: true, sets: {}, deletions: [] })
    expect(sent).toEqual([])
  })

  it('decodes every stage a refusal can name', () => {
    const answer = (...rest: unknown[]) => coreAnswering(['refused', 'k/v0', ...rest]).core
    const run = (core: ReturnType<typeof answer>) => core.facetBucketCheck('node', { 'k/v0': {} })
    const refusal = (...rest: unknown[]) => {
      const result = run(answer(...rest))
      return result.ok ? undefined : result.refusal
    }
    expect(refusal('target', ['node', 'edge'])).toEqual({
      stage: 'target',
      targets: ['node', 'edge'],
    })
    expect(refusal('malformed-key')).toEqual({ stage: 'malformed-key' })
    expect(refusal('not-current', 'a.b/v0')).toEqual({ stage: 'not-current', current: 'a.b/v0' })
    expect(refusal('unrecognized-key', ['rows', '1'], 'extra')).toEqual({
      stage: 'unrecognized-key',
      path: ['rows', '1'],
      key: 'extra',
    })
    expect(refusal('unregistered-asset', 'theme', 'v.gone', 'themes', ['v.a'])).toEqual({
      stage: 'unregistered-asset',
      field: 'theme',
      id: 'v.gone',
      kind: 'themes',
      registered: ['v.a'],
    })
    expect(run(answer('malformed-key'))).toMatchObject({ ok: false, key: 'k/v0' })
  })

  it('decodes an issue with each detail the wire carries', () => {
    const issues = [
      [['a', 0], 'invalid_type', null],
      [[], 'unrecognized_keys', ['keys', ['x', 'y']]],
      [[], 'invalid_union', ['arms', [[[[], 'invalid_type', null]], []]]],
      [['m'], 'invalid_key', ['key', [[[], 'invalid_format', null]]]],
    ]
    const result = coreAnswering(['refused', 'k/v0', 'invalid', issues]).core.facetBucketCheck(
      'node',
      { 'k/v0': {} },
    )
    expect(result).toEqual({
      ok: false,
      key: 'k/v0',
      refusal: {
        stage: 'invalid',
        issues: [
          { path: ['a', 0], code: 'invalid_type' },
          { path: [], code: 'unrecognized_keys', keys: ['x', 'y'] },
          { path: [], code: 'invalid_union', arms: [[{ path: [], code: 'invalid_type' }], []] },
          { path: ['m'], code: 'invalid_key', key: [{ path: [], code: 'invalid_format' }] },
        ],
      },
    })
  })

  it('decodes the stencils of a refused library with why each would be dropped', () => {
    const dropped = [
      ['a', 'name'],
      ['b', 'no-shape'],
      ['c', 'shape', [[['displayName'], 'too_small', null]]],
      ['d', 'facet', 'v.x/v0', 'unregistered'],
      ['e', 'facet', 'v.x/v0', 'not-current', 'v.x/v1'],
      ['f', 'facet', 'v.x/v0', 'invalid', [[[], 'invalid_type', null]]],
    ]
    const result = coreAnswering([
      'refused',
      'visual.stencils/v0',
      'library',
      dropped,
    ]).core.facetBucketCheck('document', { 'visual.stencils/v0': {} })
    expect(result).toEqual({
      ok: false,
      key: 'visual.stencils/v0',
      refusal: {
        stage: 'library',
        dropped: [
          { name: 'a', why: 'name' },
          { name: 'b', why: 'no-shape' },
          { name: 'c', why: 'shape', issues: [{ path: ['displayName'], code: 'too_small' }] },
          { name: 'd', why: 'facet', key: 'v.x/v0', facet: 'unregistered' },
          { name: 'e', why: 'facet', key: 'v.x/v0', facet: 'not-current', current: 'v.x/v1' },
          {
            name: 'f',
            why: 'facet',
            key: 'v.x/v0',
            facet: 'invalid',
            issues: [{ path: [], code: 'invalid_type' }],
          },
        ],
      },
    })
  })

  it('stops a bucket at the key whose payload holds the reserved key, as the server walk is stopped', () => {
    const reserved = JSON.parse('{"__proto__": {"a": 1}}') as object
    const { core, sent } = coreAnswering(['ok', ['m', 'a.b/v0', ['m']], ['s']])
    const stopped = core.facetBucketCheck('node', {
      'a.b/v0': {},
      'c.d/v0': { nested: [reserved] },
      'e.f/v0': 1,
    })
    expect(stopped).toEqual({ ok: false, key: 'c.d/v0', refusal: { stage: 'reserved-key' } })
    expect(sent[0]?.[1]).toBe(JSON.stringify(['m', 'a.b/v0', ['m']]))
    // A refusal among the keys before it is the one the server reaches first.
    const earlier = coreAnswering(['refused', 'a.b/v0', 'malformed-key']).core
    expect(earlier.facetBucketCheck('node', { 'a.b/v0': {}, 'c.d/v0': reserved })).toMatchObject({
      key: 'a.b/v0',
      refusal: { stage: 'malformed-key' },
    })
    // A library refusal of the keys before it is one the server never reaches.
    const library = coreAnswering([
      'refused',
      'visual.stencils/v0',
      'library',
      [['a', 'name']],
    ]).core
    expect(library.facetBucketCheck('document', { 'visual.stencils/v0': {}, x: reserved })).toEqual(
      {
        ok: false,
        key: 'x',
        refusal: { stage: 'reserved-key' },
      },
    )
    // Nothing before it: nothing is asked.
    const first = coreAnswering('not called')
    expect(first.core.facetBucketCheck('node', { x: reserved })).toMatchObject({ key: 'x' })
    expect(first.sent).toEqual([])
    // A deletion is not judged, so a null never holds one.
    expect(
      coreAnswering(['ok', ['m'], ['s', 'x']]).core.facetBucketCheck('node', { x: null }).ok,
    ).toBe(true)
  })

  it('declines what the wire cannot carry, including a key the TypeScript would read as absent', () => {
    const { core, sent } = coreAnswering('not called')
    for (const bucket of [
      { 'a.b/v0': { present: 1, absent: undefined } },
      { 'a.b/v0': undefined },
      { 'a.b/v0': () => 1 },
      { '\ud800': {} },
      { 'a.b/v0': 'lone \ud800' },
    ]) {
      expect(() => core.facetBucketCheck('node', bucket as never)).toThrow(
        expect.objectContaining({ name: 'CoreInputRefused', code: 'malformed' }),
      )
    }
    expect(() => core.facetBucketCheck('node', { 'a.b/v0': {} }, { s: undefined })).toThrow(
      CoreInputRefused,
    )
    expect(sent).toEqual([])
  })

  it('refuses a call past the cap before it reaches the artifact, the two texts counted together', () => {
    const { core, sent } = coreAnswering(['ok', ['m'], ['s']])
    const half = 'x'.repeat(Math.ceil(FACET_BUCKET_CHECK_CAPS.maxBytes / 2))
    expect(() => core.facetBucketCheck('node', { 'a.b/v0': half }, { s: half })).toThrow(
      expect.objectContaining({ name: 'CoreInputRefused', code: 'input-too-large' }),
    )
    expect(sent).toEqual([])
  })

  it('throws what the artifact declined, with its code and class', () => {
    refusedWith(['declined', 'malformed', 'too-deep'], (core) =>
      core.facetBucketCheck('node', { 'a.b/v0': {} }),
    ).toThrow(expect.objectContaining({ code: 'malformed', detail: 'too-deep' }))
    refusedWith(['declined', 'input-too-large', 'too-large'], (core) =>
      core.facetBucketCheck('node', { 'a.b/v0': {} }),
    ).toThrow(expect.objectContaining({ code: 'input-too-large', detail: 'too-large' }))
    refusedWith(['declined', 'bogus'], (core) =>
      core.facetBucketCheck('node', { 'a.b/v0': {} }),
    ).toThrow(expect.objectContaining({ code: 'malformed', detail: 'answer' }))
  })

  it('refuses an answer it cannot account for as malformed rather than half reading it', () => {
    const garbled: unknown[] = [
      [],
      ['ok'],
      ['ok', 'sets', ['s']],
      ['ok', ['m'], ['s', 1]],
      ['ok', ['m'], ['s'], 'extra'],
      ['refused'],
      ['refused', 'k/v0'],
      ['refused', 'k/v0', 'nonsense'],
      ['refused', 'k/v0', 'target', 'node'],
      ['refused', 'k/v0', 'malformed-key', 'extra'],
      ['refused', 'k/v0', 'not-current', 1],
      ['refused', 'k/v0', 'invalid', 'issues'],
      ['refused', 'k/v0', 'invalid', [[['a'], 'not_a_code', null]]],
      ['refused', 'k/v0', 'invalid', [[[{}], 'invalid_type', null]]],
      ['refused', 'k/v0', 'invalid', [[[], 'invalid_type', ['keys', [1]]]]],
      ['refused', 'k/v0', 'invalid', [[[], 'invalid_type', ['arms', 'x']]]],
      ['refused', 'k/v0', 'invalid', [[[], 'invalid_type', ['key', 'x']]]],
      ['refused', 'k/v0', 'invalid', [[[], 'invalid_type', ['other', []]]]],
      ['refused', 'k/v0', 'invalid', [[[], 'invalid_type', null, 'extra']]],
      ['refused', 'k/v0', 'unregistered-asset', 'f', 'i', 'colours', []],
      ['refused', 'k/v0', 'unregistered-asset', 'f', 'i', 'themes'],
      ['refused', 'k/v0', 'unrecognized-key', ['a'], 3],
      ['refused', 'k/v0', 'library', []],
      ['refused', 'k/v0', 'library', [['a', 'weird']]],
      ['refused', 'k/v0', 'library', [['a', 'name', 'extra']]],
      ['refused', 'k/v0', 'library', [['a', 'shape']]],
      ['refused', 'k/v0', 'library', [['a', 'facet', 'k', 'unregistered', 'extra']]],
      ['refused', 'k/v0', 'library', [['a', 'facet', 'k', 'not-current']]],
      ['refused', 'k/v0', 'library', [['a', 'facet', 'k', 'invalid']]],
      ['refused', 'k/v0', 'library', [['a', 'facet', 'k', 'other']]],
      ['refused', 'k/v0', 'library', [[1, 'name']]],
      ['refused', 'k/v0', 'library', [['a', 'facet', 2, 'unregistered']]],
    ]
    for (const answer of garbled) {
      refusedWith(answer, (core) => core.facetBucketCheck('node', { 'k/v0': {} })).toThrow(
        expect.objectContaining({ name: 'CoreInputRefused', code: 'malformed' }),
      )
    }
  })
})
