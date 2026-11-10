import { describe, expect, it } from 'vitest'
import { OKF_PARSE_CAPS, OKF_SERIALIZE_CAPS } from './generated/input-caps.js'
import { type CoreGlue, CoreOkfUnwritable, coreFrom, EXPECTED_ABI } from './index.js'
import type { OkfDocument } from './okf.js'

/** A core over a glue that answers `answer` and records what it was sent. */
function coreAnswering(answer: unknown) {
  const sent: string[] = []
  const marks: number[] = []
  const reply = (text: string, mark = 0) => {
    sent.push(text)
    marks.push(mark)
    return JSON.stringify(answer)
  }
  const glue: CoreGlue = {
    initSync: () => undefined,
    abi_version: () => EXPECTED_ABI,
    edge_route_layout: () => new Float64Array(),
    okf_parse: reply,
    okf_serialize: reply,
  }
  return { core: coreFrom(glue, new Uint8Array()), sent, marks }
}

/** A document with a block and no body, which is all of it the artifact is sent. */
const FENCED = '---\nk: v\n---\n'

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
    const head = '---\nt\n---\n'
    const { core } = coreAnswering(['ok', head.length, wire])
    const read = core.parseOkf(`${head}\u{1F600}x-body`)
    expect(read).toEqual({
      ok: true,
      value: {
        frontmatter: { type: 'note', facets: { 'a.b/v1': [-0, 9007199254740993n, null, true] } },
        body: '\u{1F600}x-body',
      },
    })
    if (!read.ok) return
    const facet = (read.value.frontmatter.facets as Record<string, unknown[]>)['a.b/v1']
    expect(Object.is(facet?.[0], -0)).toBe(true)
  })

  it('sends the head of the document and keeps the body, whatever the body holds', () => {
    const head = '---\ntype: a\n---\r\n'
    const body = `${'x'.repeat(OKF_PARSE_CAPS.maxBytes * 2)}\ud800\u{1F600}`
    const { core, sent, marks } = coreAnswering(['ok', head.length, ['m', 'type', 'a']])
    expect(core.parseOkf(head + body)).toEqual({
      ok: true,
      value: { frontmatter: { type: 'a' }, body },
    })
    expect(sent).toEqual([head])
    expect(marks).toEqual([0])
  })

  it('cuts the head where the closing fence is and takes its line break with it', () => {
    const heads: [string, string][] = [
      ['---\na: 1\n---\n', '\nbody'],
      ['---\na: 1\n---\n', 'body'],
      ['---\r\na: 1\r\n---\r\n', '---\nnot a fence'],
      ['---\n\n---', 'abc'],
      ['---\na: 1\n---\r', 'x'],
    ]
    for (const [head, rest] of heads) {
      const { core, sent } = coreAnswering(['ok', head.length, ['m', 'type', 'a']])
      core.parseOkf(head + rest)
      expect(sent, JSON.stringify(head + rest)).toEqual([head])
    }
  })

  it('sends nothing of a text that opens no block, for the artifact to name', () => {
    const { core, sent } = coreAnswering(['err', 'frontmatter-schema', 'nofence', []])
    for (const text of [
      '',
      'no',
      '---x\ntype: a\n---\n',
      '---\ntype: a',
      `---\n${'a'.repeat(1e6)}`,
    ]) {
      expect(core.parseOkf(text)).toMatchObject({
        ok: false,
        error: { stage: 'frontmatter-schema' },
      })
    }
    expect(sent).toEqual(['', '', '', '', ''])
  })

  it('puts a mark where the head holds a lone surrogate, one the head holds nowhere else', () => {
    const head = '---\ntype: a\ud800b\n# \udc00 \ue000\n---\n'
    const { core, sent, marks } = coreAnswering(['ok', head.length, ['m', 'type', 'a']])
    core.parseOkf(head)
    const [mark] = marks
    expect(mark).toBeGreaterThan(0)
    const marked = String.fromCodePoint(mark ?? 0)
    expect(sent[0]).toBe(head.replaceAll('\ud800', marked).replaceAll('\udc00', marked))
    expect(head).not.toContain(marked)
    // A pair is not lone, and nothing is replaced.
    const pair = '---\ntype: \u{1F600}\n---\n'
    const paired = coreAnswering(['ok', pair.length, ['m', 'type', 'a']])
    paired.core.parseOkf(pair)
    expect(paired.marks).toEqual([0])
  })

  it('does not take a mark the head could spell with an escape', () => {
    const head = '---\ntype: "\\ue000 \\U0000E001" \ud800\n---\n'
    const { core, marks } = coreAnswering(['ok', head.length, ['m', 'type', 'a']])
    core.parseOkf(head)
    expect([0xe000, 0xe001]).not.toContain(marks[0])
    expect(marks[0]).toBeGreaterThan(0)
  })

  it('refuses a head past the cap before it crosses, and sends one at it', () => {
    const fences = '---\n\n---'
    const fill = (units: number) => `---\n${'a'.repeat(units - fences.length)}\n---`
    const { core, sent } = coreAnswering(['ok', OKF_PARSE_CAPS.maxBytes, ['m']])
    expect(() => core.parseOkf(fill(OKF_PARSE_CAPS.maxBytes + 1))).toThrow(
      expect.objectContaining({ code: 'input-too-large' }),
    )
    expect(sent).toEqual([])
    core.parseOkf(fill(OKF_PARSE_CAPS.maxBytes))
    expect(sent).toHaveLength(1)
  })

  it('refuses an offset that is not the end of the head', () => {
    for (const offset of [0, 3, 12]) {
      expect(() =>
        coreAnswering(['ok', offset, ['m', 'type', 'a']]).core.parseOkf('---\na: 1\n---\nbody'),
      ).toThrow(expect.objectContaining({ code: 'malformed' }))
    }
  })

  it('answers a refusal the way the TypeScript words it, and each issue by path and code', () => {
    const refusal = (...answer: unknown[]) =>
      coreAnswering(['err', ...answer]).core.parseOkf(FENCED)
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
      expect(() => coreAnswering(answer).core.parseOkf(FENCED), JSON.stringify(answer)).toThrow(
        expect.objectContaining({ name: 'CoreInputRefused', code: 'malformed' }),
      )
    }
    for (const code of ['input-too-large', 'malformed']) {
      expect(() => coreAnswering(['refused', code]).core.parseOkf(FENCED)).toThrow(
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

  it('names, before calling the artifact, each value the wire cannot carry, as the TypeScript does', () => {
    const { core, sent } = coreAnswering(['ok', ''])
    const cyclic: Record<string, unknown> = { type: 'n' }
    cyclic.self = cyclic
    const sparse: unknown[] = []
    sparse[1] = 'x'
    const unsafe = (fm: object): unknown => {
      try {
        core.serializeOkf(doc(fm))
      } catch (err) {
        return err instanceof CoreOkfUnwritable ? err.issues : err
      }
      return undefined
    }
    const issue = (path: (string | number)[], message: string) => ({ path, message })
    expect(unsafe({ type: undefined })).toEqual([issue(['type'], 'undefined is not yaml-safe')])
    expect(unsafe({ type: 'n', title: () => 1 })).toEqual([
      issue(['title'], 'function is not yaml-safe'),
    ])
    expect(unsafe({ type: 'n', title: Symbol('s') })).toEqual([
      issue(['title'], 'symbol is not yaml-safe'),
    ])
    expect(unsafe({ type: 'n', facets: { 'a.b/v1': new Date(0) } })).toEqual([
      issue(['facets', 'a.b/v1'], 'Date is not yaml-safe; use a plain list or mapping'),
    ])
    expect(unsafe({ type: 'n', facets: { 'a.b/v1': sparse } })).toEqual([
      issue(['facets', 'a.b/v1', 0], 'undefined is not yaml-safe'),
    ])
    expect(unsafe({ type: 'n', facets: { 'a.b/v1': ['\ud800'] } })).toEqual([
      issue(['facets', 'a.b/v1', 0], 'a lone UTF-16 surrogate is not yaml-safe'),
    ])
    // A reserved key anywhere is reported first, at the root, and once.
    const reserved = Object.fromEntries([['__proto__', 1]])
    expect(unsafe({ type: 'n', title: undefined, facets: { a: reserved, b: [reserved] } })).toEqual(
      [
        issue([], 'a key named "__proto__" is not yaml-safe'),
        issue(['title'], 'undefined is not yaml-safe'),
      ],
    )
    expect(unsafe({ type: 'n', facets: { '\udc00': 1 } })).toEqual([
      issue(['facets'], 'a lone UTF-16 surrogate is not yaml-safe'),
    ])
    expect(unsafe({ type: '\ud800' })).toEqual([
      issue(['type'], 'a lone UTF-16 surrogate is not yaml-safe'),
    ])
    expect(unsafe(cyclic)).toEqual([issue(['self', 'self'], 'cyclic reference is not yaml-safe')])
    expect(sent).toEqual([])
    core.serializeOkf(doc(Object.assign(Object.create(null), { type: 'n' })))
    expect(sent).toHaveLength(1)
  })

  it('reports what the artifact cannot see and what it can in one walk order', () => {
    const { core, sent } = coreAnswering(['ok', ''])
    const reported = (fm: object): unknown => {
      try {
        core.serializeOkf(doc(fm))
      } catch (err) {
        return err instanceof CoreOkfUnwritable ? err.issues : err
      }
      return undefined
    }
    expect(
      reported({
        type: 'n',
        facetsRaw: { z: Number.NaN, a: '\ufeff', b: 1n },
        facets: { 'a.b/v1': [-Infinity, '\ud800'] },
        title: undefined,
      }),
    ).toEqual([
      { path: ['title'], message: 'undefined is not yaml-safe' },
      { path: ['a'], message: 'a byte-order mark is not yaml-safe' },
      { path: ['b'], message: 'bigint is not yaml-safe' },
      { path: ['z'], message: 'NaN is not yaml-safe' },
      { path: ['facets', 'a.b/v1', 0], message: '-Infinity is not yaml-safe' },
      { path: ['facets', 'a.b/v1', 1], message: 'a lone UTF-16 surrogate is not yaml-safe' },
    ])
    expect(sent).toEqual([])
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

  it('words each place the artifact found no spelling for, at its path', () => {
    const answer = [
      'unwritable',
      [
        [[], 'reserved-key'],
        [['facets'], 'byte-order-mark'],
        [['facets', 'k', 0], 'nan'],
        [['a'], 'infinity'],
        [['b'], 'negative-infinity'],
        [['c', 1], 'big-int'],
        [['d'], 'byte-order-mark'],
      ],
    ]
    const { core } = coreAnswering(answer)
    let thrown: unknown
    try {
      core.serializeOkf(doc({ type: 'n' }))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(CoreOkfUnwritable)
    expect(thrown).toMatchObject({
      name: 'CoreOkfUnwritable',
      issues: [
        { path: [], message: 'a key named "__proto__" is not yaml-safe' },
        { path: ['facets'], message: 'a byte-order mark is not yaml-safe' },
        { path: ['facets', 'k', 0], message: 'NaN is not yaml-safe' },
        { path: ['a'], message: 'Infinity is not yaml-safe' },
        { path: ['b'], message: '-Infinity is not yaml-safe' },
        { path: ['c', 1], message: 'bigint is not yaml-safe' },
        { path: ['d'], message: 'a byte-order mark is not yaml-safe' },
      ],
    })
  })

  it('refuses a value nested past the writer as an input past the cap, and relays a refusal', () => {
    expect(() =>
      coreAnswering([
        'unwritable',
        [
          [['a'], 'nan'],
          [['b'], 'too-deep'],
        ],
      ]).core.serializeOkf(doc({ type: 'n' })),
    ).toThrow(expect.objectContaining({ name: 'CoreInputRefused', code: 'input-too-large' }))
    for (const code of ['input-too-large', 'malformed']) {
      expect(() => coreAnswering(['refused', code]).core.serializeOkf(doc({ type: 'n' }))).toThrow(
        expect.objectContaining({ code }),
      )
    }
    for (const answer of [
      [],
      ['ok', 1],
      ['unwritable', 1],
      ['unwritable', []],
      ['unwritable', [[['a'], 'other']]],
      ['unwritable', [[[{}], 'nan']]],
      ['unwritable', [['a', 'nan']]],
      ['refused', 'x'],
    ]) {
      expect(
        () => coreAnswering(answer).core.serializeOkf(doc({ type: 'n' })),
        JSON.stringify(answer),
      ).toThrow(expect.objectContaining({ name: 'CoreInputRefused', code: 'malformed' }))
    }
  })
})
