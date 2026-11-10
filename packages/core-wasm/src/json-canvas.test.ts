import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { JSON_CANVAS_PARSE_CAPS, JSON_CANVAS_SERIALIZE_CAPS } from './generated/input-caps.js'
import {
  type CoreGlue,
  CoreInputRefused,
  CoreSpatialInvalid,
  coreFrom,
  EXPECTED_ABI,
} from './index.js'

/** A core over a glue that answers `answer` and records what it was sent. */
function coreAnswering(answer: unknown) {
  const sent: string[] = []
  const strict: boolean[] = []
  const raw = typeof answer === 'string' ? answer : JSON.stringify(answer)
  const glue: CoreGlue = {
    initSync: () => undefined,
    abi_version: () => EXPECTED_ABI,
    edge_route_layout: () => new Float64Array(),
    okf_parse: () => '',
    okf_serialize: () => '',
    json_canvas_parse: (text) => {
      sent.push(text)
      return raw
    },
    json_canvas_serialize: (canvas, isStrict) => {
      sent.push(canvas)
      strict.push(isStrict)
      return raw
    },
  }
  return { core: coreFrom(glue, new Uint8Array()), sent, strict }
}

const canvas = (extra: object = {}): SpatialCanvas => ({ nodes: [], edges: [], ...extra })

const refusal = (run: () => unknown): CoreInputRefused => {
  try {
    run()
  } catch (error) {
    if (error instanceof CoreInputRefused) return error
    throw error
  }
  throw new Error('nothing was thrown')
}

describe('the JSON Canvas shim reading', () => {
  it('decodes the canvas wire: compact integers, bits, bigints, and keys in the order sent', () => {
    const wire = [
      'ok',
      [
        'm',
        'nodes',
        [
          's',
          [
            'm',
            'id',
            'a',
            'x',
            -3,
            'y',
            ['f', '8000000000000000'],
            'width',
            ['f', '3ff8000000000000'],
          ],
        ],
        'edges',
        ['s'],
        'facets',
        ['m', '1', ['b', '9007199254740993'], '__proto__', null],
      ],
    ]
    const { core, sent } = coreAnswering(wire)
    const read = core.parseSpatial('{"nodes":[]}')
    expect(sent).toEqual(['{"nodes":[]}'])
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const node = (read.value.nodes as unknown as Record<string, unknown>[])[0] as Record<
      string,
      unknown
    >
    expect(Object.keys(node)).toEqual(['id', 'x', 'y', 'width'])
    expect(node.x).toBe(-3)
    expect(Object.is(node.y, -0)).toBe(true)
    expect(node.width).toBe(1.5)
    expect(Object.keys(read.value.facets as object)).toEqual(['1', '__proto__'])
    expect((read.value.facets as Record<string, unknown>)['1']).toBe(9007199254740993n)
  })

  it('words a refusal in the TypeScript own words and keeps each issue path and code', () => {
    const issues = [
      [['nodes', 0, 'text'], 'invalid_type'],
      [['edges', 1, 'toNode'], 'custom', 'edge "e" references nonexistent toNode "z"'],
    ]
    const { core } = coreAnswering(['err', 'json-canvas-schema', 'schema', issues])
    expect(core.parseSpatial('{}')).toEqual({
      ok: false,
      error: {
        stage: 'json-canvas-schema',
        message: 'JSON Canvas document failed schema validation',
        issues: [
          {
            code: 'invalid_type',
            path: ['nodes', 0, 'text'],
            message: 'Invalid input: wrong type',
          },
          {
            code: 'custom',
            path: ['edges', 1, 'toNode'],
            message: 'edge "e" references nonexistent toNode "z"',
          },
        ],
      },
    })
    const comments = coreAnswering(['err', 'json-canvas-schema', 'conversation', []]).core
    const refused = comments.parseSpatial('{}')
    expect(!refused.ok && refused.error.message).toMatch(
      /^this file carries x-whiteboard\.comments/,
    )
    expect(!refused.ok && refused.error.issues).toEqual([])
  })

  it('takes the syntax message from JSON.parse itself, and refuses an answer it contradicts', () => {
    const { core } = coreAnswering(['err', 'json-syntax', 'syntax', []])
    let expected = ''
    try {
      JSON.parse('{')
    } catch (error) {
      expected = (error as Error).message
    }
    expect(core.parseSpatial('{')).toEqual({
      ok: false,
      error: {
        stage: 'json-syntax',
        message: `malformed JSON Canvas text: ${expected}`,
        issues: [],
      },
    })
    expect(refusal(() => core.parseSpatial('{}')).code).toBe('malformed')
  })

  it('refuses a lone surrogate and a text past the cap before calling the artifact', () => {
    const { core, sent } = coreAnswering(['ok', ['m', 'nodes', ['s'], 'edges', ['s']]])
    const surrogate = refusal(() => core.parseSpatial('{"a":"\ud800"}'))
    expect([surrogate.code, surrogate.detail, surrogate.operation]).toEqual([
      'malformed',
      'lone-surrogate',
      'json_canvas_parse',
    ])
    const large = refusal(() => core.parseSpatial(' '.repeat(JSON_CANVAS_PARSE_CAPS.maxBytes + 1)))
    expect([large.code, large.detail]).toEqual(['input-too-large', 'too-large'])
    expect(sent).toEqual([])
    expect(core.parseSpatial(' '.repeat(JSON_CANVAS_PARSE_CAPS.maxBytes)).ok).toBe(true)
  })

  it('throws what the artifact declined, with its class', () => {
    for (const [code, detail] of [
      ['malformed', 'url'],
      ['malformed', 'too-deep'],
      ['input-too-large', 'too-large'],
    ] as const) {
      const { core } = coreAnswering(['refused', code, detail])
      const error = refusal(() => core.parseSpatial('{}'))
      expect([error.code, error.detail, error.operation]).toEqual([
        code,
        detail,
        'json_canvas_parse',
      ])
    }
  })

  it('refuses an answer it cannot account for', () => {
    for (const answer of [
      'not json',
      [],
      ['ok', 3],
      ['ok', ['s']],
      ['ok', ['m', 'nodes', ['s', 1.5]]],
      ['err', 'json-canvas-schema', 'schema', [[['a'], 'unknown_code']]],
      ['err', 'json-canvas-schema', 'schema', [[[{}], 'custom']]],
      ['err', 'json-canvas-schema', 'schema', [[['a'], 'custom', 7]]],
      ['err', 'json-canvas-schema', 'other', []],
      ['err', 'frontmatter-schema', 'schema', []],
      ['refused', 'other', 'x'],
    ]) {
      const { core } = coreAnswering(answer)
      if (answer === 'not json') {
        expect(() => core.parseSpatial('{}')).toThrow(SyntaxError)
        continue
      }
      const error = refusal(() => core.parseSpatial('{}'))
      expect([error.code, error.detail], JSON.stringify(answer)).toEqual(['malformed', 'answer'])
    }
  })
})

describe('the JSON Canvas shim writing', () => {
  it('sends the canvas wire in the order it holds, integers compact, and the mode', () => {
    const { core, sent, strict } = coreAnswering('{"nodes":[]}')
    const written = core.serializeSpatial(
      canvas({
        facets: { 'a.b/v1': { n: 1.5, z: -0, big: 9007199254740993n, list: [null, true, 'x'] } },
        tags: [],
      }),
      'strict',
    )
    expect(written).toBe('{"nodes":[]}')
    core.serializeSpatial(canvas(), 'extended')
    expect(strict).toEqual([true, false])
    expect(JSON.parse(sent[0] as string)).toEqual([
      'm',
      'nodes',
      ['s'],
      'edges',
      ['s'],
      'facets',
      [
        'm',
        'a.b/v1',
        [
          'm',
          'n',
          ['f', '3ff8000000000000'],
          'z',
          ['f', '8000000000000000'],
          'big',
          ['b', '9007199254740993'],
          'list',
          ['s', null, true, 'x'],
        ],
      ],
      'tags',
      ['s'],
    ])
  })

  it('leaves out a key whose value is undefined, as JSON.stringify does, but not a list item', () => {
    const { core, sent } = coreAnswering('{}')
    core.serializeSpatial(canvas({ label: undefined, tags: ['a'] }), 'extended')
    expect(JSON.parse(sent[0] as string)).toEqual([
      'm',
      'nodes',
      ['s'],
      'edges',
      ['s'],
      'tags',
      ['s', 'a'],
    ])
    expect(() => core.serializeSpatial(canvas({ tags: [undefined] }), 'extended')).toThrow(
      CoreInputRefused,
    )
  })

  it('throws CoreSpatialInvalid, naming each place, for what the strict validation refuses', () => {
    const { core } = coreAnswering(['schema', [[['edges', 0, 'toNode'], 'custom']]])
    try {
      core.serializeSpatial(canvas(), 'strict')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(CoreSpatialInvalid)
      expect((error as CoreSpatialInvalid).issues).toEqual([
        { code: 'custom', path: ['edges', 0, 'toNode'], message: 'Invalid input' },
      ])
      expect((error as Error).message).toContain('edges.0.toNode')
    }
  })

  it('refuses what the wire cannot carry, before calling the artifact', () => {
    const { core, sent } = coreAnswering('{}')
    class Odd {}
    const sparse: unknown[] = []
    sparse[1] = 1
    let deep: unknown = null
    for (let i = 0; i < 120; i++) deep = [deep]
    const cases: SpatialCanvas[] = [
      canvas({ facets: { 'a.b/v1': new Odd() } }),
      canvas({ facets: { 'a.b/v1': { s: '\ud800' } } }),
      canvas({ facets: { 'a.b/v1': { '\ud800': 1 } } }),
      canvas({ facets: { 'a.b/v1': sparse } }),
      canvas({ facets: { 'a.b/v1': deep } }),
      canvas({ facets: { 'a.b/v1': () => 1 } }),
    ]
    for (const c of cases) {
      const error = refusal(() => core.serializeSpatial(c, 'extended'))
      expect([error.code, error.detail, error.operation]).toEqual([
        'malformed',
        'wire',
        'json_canvas_serialize',
      ])
    }
    const big = canvas({ tags: ['x'.repeat(JSON_CANVAS_SERIALIZE_CAPS.maxBytes)] })
    const large = refusal(() => core.serializeSpatial(big, 'extended'))
    expect([large.code, large.detail]).toEqual(['input-too-large', 'too-large'])
    expect(sent).toEqual([])
  })

  it('throws what the artifact declined, and an answer it cannot account for as malformed', () => {
    const declined = coreAnswering(['refused', 'malformed', 'url']).core
    const error = refusal(() => declined.serializeSpatial(canvas(), 'strict'))
    expect([error.code, error.detail]).toEqual(['malformed', 'url'])
    for (const answer of [[], ['schema', []], ['schema', [[['a'], 'nope']]], ['other'], 'null']) {
      const { core } = coreAnswering(answer)
      const unexplained = refusal(() => core.serializeSpatial(canvas(), 'strict'))
      expect([unexplained.code, unexplained.detail], JSON.stringify(answer)).toEqual([
        'malformed',
        'answer',
      ])
    }
  })
})
