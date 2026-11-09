import { describe, expect, it } from 'vitest'
import { OKF_PARSE_CAPS, OKF_SERIALIZE_CAPS } from './generated/input-caps.js'
import {
  type CoreGlue,
  CoreInputRefused,
  CoreOkfUnwritable,
  coreFrom,
  EXPECTED_ABI,
} from './index.js'
import type { OkfDocument } from './okf.js'

/** A core over a glue that answers `answer` and records what it was sent. */
function coreAnswering(answer: unknown) {
  const sent: string[] = []
  const reply = (text: string) => {
    sent.push(text)
    return JSON.stringify(answer)
  }
  const glue: CoreGlue = {
    initSync: () => undefined,
    abi_version: () => EXPECTED_ABI,
    edge_route_layout: () => new Float64Array(),
    okf_parse: reply,
    okf_serialize: reply,
  }
  return { core: coreFrom(glue, new Uint8Array()), sent }
}

const doc = (frontmatter: object, body = ''): OkfDocument => ({
  frontmatter: frontmatter as OkfDocument['frontmatter'],
  body,
})

describe('the OKF shim reading', () => {
  it('slices the body off the text at the UTF-16 offset and decodes the frontmatter', () => {
    const wire = [
      'm',
      'type',
      'note',
      'facets',
      ['m', 'a.b/v1', ['s', ['f', '8000000000000000'], ['b', '9007199254740993'], null, true]],
    ]
    const { core } = coreAnswering(['ok', 3, wire])
    const read = core.parseOkf('\u{1F600}x-body')
    expect(read).toEqual({
      ok: true,
      value: {
        frontmatter: { type: 'note', facets: { 'a.b/v1': [-0, 9007199254740993n, null, true] } },
        body: 'x-body'.slice(1),
      },
    })
    if (!read.ok) return
    const facet = (read.value.frontmatter.facets as Record<string, unknown[]>)['a.b/v1']
    expect(Object.is(facet?.[0], -0)).toBe(true)
  })

  it('refuses a text it must not send before it calls the artifact', () => {
    const { core, sent } = coreAnswering(['ok', 0, ['m']])
    for (const [text, code] of [
      ['---\ntype: a\n---\n\ud800', 'malformed'],
      ['\udc00', 'malformed'],
      ['a'.repeat(OKF_PARSE_CAPS.maxBytes + 1), 'input-too-large'],
    ] as const) {
      expect(() => core.parseOkf(text)).toThrow(expect.objectContaining({ code }))
    }
    expect(sent).toEqual([])
    core.parseOkf('a'.repeat(OKF_PARSE_CAPS.maxBytes))
    expect(sent).toHaveLength(1)
  })

  it('answers a refusal the way the TypeScript words it, and each issue by path and code', () => {
    const refusal = (...answer: unknown[]) => coreAnswering(['err', ...answer]).core.parseOkf('x')
    expect(refusal('frontmatter-schema', 'nofence', [])).toMatchObject({
      ok: false,
      error: {
        stage: 'frontmatter-schema',
        message: expect.stringContaining('does not start'),
        issues: [],
      },
    })
    expect(refusal('frontmatter-schema', 'reserved', [])).toMatchObject({
      error: { message: 'frontmatter holds a key named "__proto__", which no document may hold' },
    })
    expect(
      refusal('frontmatter-schema', 'schema', [
        [['type'], 'invalid_type'],
        [['tags', 1], 'too_small'],
        [['generated', 'at'], 'invalid_format'],
        [['facets', 'x'], 'custom'],
      ]),
    ).toMatchObject({
      error: {
        stage: 'frontmatter-schema',
        message: 'frontmatter failed OKF schema validation',
        issues: [
          { code: 'invalid_type', path: ['type'] },
          { code: 'too_small', path: ['tags', 1] },
          { code: 'invalid_format', path: ['generated', 'at'] },
          { code: 'custom', path: ['facets', 'x'] },
        ],
      },
    })
    for (const cls of ['syntax', 'anchor', 'depth', 'subset']) {
      expect(refusal('yaml', cls, [])).toMatchObject({
        error: { stage: 'yaml', message: expect.stringMatching(/^malformed YAML frontmatter: /) },
      })
    }
  })

  it('refuses an answer it cannot account for, and relays the artifact refusing', () => {
    const answers: unknown[] = [
      [],
      ['ok', 99, ['m']],
      ['ok', 1.5, ['m']],
      ['ok', 0, 'x'],
      ['ok', 0, ['x']],
      ['ok', 0, ['m', 'k']],
      ['ok', 0, ['m', 1, null]],
      ['ok', 0, ['m', 'k', ['f', 'zz']]],
      ['ok', 0, ['m', 'k', ['b', 1]]],
      ['ok', 0, ['m', 'k', 1]],
      ['err', 'yaml', 'other', []],
      ['err', 'yaml', 'syntax'],
      ['err', 'other', 'syntax', []],
      ['err', 'frontmatter-schema', 'schema', [[['a'], 'unknown']]],
      ['err', 'frontmatter-schema', 'schema', [[[{}], 'custom']]],
      ['err', 'frontmatter-schema', 'other', []],
      ['refused', 'other'],
    ]
    for (const answer of answers) {
      expect(() => coreAnswering(answer).core.parseOkf('x'), JSON.stringify(answer)).toThrow(
        expect.objectContaining({ name: 'CoreInputRefused', code: 'malformed' }),
      )
    }
    for (const code of ['input-too-large', 'malformed']) {
      expect(() => coreAnswering(['refused', code]).core.parseOkf('x')).toThrow(
        expect.objectContaining({ code }),
      )
    }
  })
})

describe('the OKF shim writing', () => {
  it('sends the frontmatter as the wire, never the body, and appends the body', () => {
    const { core, sent } = coreAnswering(['ok', '---\ntype: n\n---\n'])
    const text = core.serializeOkf(
      doc(
        {
          type: 'n',
          tags: ['a'],
          facets: { 'a.b/v1': [-0, 1.5, 3n, null, false] },
          facetsRaw: { k: {} },
        },
        'the body',
      ),
    )
    expect(text).toBe('---\ntype: n\n---\nthe body')
    expect(JSON.parse(sent[0] ?? '')).toEqual([
      'm',
      'type',
      'n',
      'tags',
      ['s', 'a'],
      'facets',
      [
        'm',
        'a.b/v1',
        ['s', ['f', '8000000000000000'], ['f', '3ff8000000000000'], ['b', '3'], null, false],
      ],
      'facetsRaw',
      ['m', 'k', ['m']],
    ])
    expect(sent[0]).not.toContain('the body')
  })

  it('refuses a document the wire cannot carry before calling the artifact', () => {
    const { core, sent } = coreAnswering(['ok', ''])
    const cyclic: Record<string, unknown> = { type: 'n' }
    cyclic.self = cyclic
    const sparse: unknown[] = []
    sparse[1] = 'x'
    const refused = [
      { type: undefined },
      { type: 'n', title: () => 1 },
      { type: 'n', title: Symbol('s') },
      { type: 'n', facets: { 'a.b/v1': new Date(0) } },
      { type: 'n', facets: { 'a.b/v1': new Map() } },
      { type: 'n', facets: { 'a.b/v1': sparse } },
      { type: 'n', facets: { 'a.b/v1': ['\ud800'] } },
      { type: 'n', facets: { '\udc00': 1 } },
      { type: '\ud800' },
      cyclic,
    ]
    for (const fm of refused) {
      expect(() => core.serializeOkf(doc(fm))).toThrow(
        expect.objectContaining({ name: 'CoreInputRefused', code: 'malformed' }),
      )
    }
    expect(sent).toEqual([])
    core.serializeOkf(doc(Object.assign(Object.create(null), { type: 'n' })))
    expect(sent).toHaveLength(1)
  })

  it('refuses a wire past the cap, and sends one at it', () => {
    const { core, sent } = coreAnswering(['ok', ''])
    const at = OKF_SERIALIZE_CAPS.maxBytes - JSON.stringify(['m', 'type', '']).length
    core.serializeOkf(doc({ type: 'a'.repeat(at) }))
    expect(() => core.serializeOkf(doc({ type: 'a'.repeat(at + 1) }))).toThrow(
      expect.objectContaining({ code: 'input-too-large' }),
    )
    expect(sent).toHaveLength(1)
  })

  it('names a value with no spelling, and relays a refusal', () => {
    expect(() =>
      coreAnswering(['unwritable', 'big-int']).core.serializeOkf(doc({ type: 'n' })),
    ).toThrow(expect.objectContaining({ name: 'CoreOkfUnwritable', reason: 'big-int' }))
    expect(() =>
      coreAnswering(['unwritable', 'big-int']).core.serializeOkf(doc({ type: 'n' })),
    ).toThrow(CoreOkfUnwritable)
    for (const code of ['input-too-large', 'malformed']) {
      expect(() => coreAnswering(['refused', code]).core.serializeOkf(doc({ type: 'n' }))).toThrow(
        expect.objectContaining({ code }),
      )
    }
    for (const answer of [[], ['ok', 1], ['unwritable', 1], ['refused', 'x']]) {
      expect(() => coreAnswering(answer).core.serializeOkf(doc({ type: 'n' }))).toThrow(
        CoreInputRefused,
      )
    }
  })
})
