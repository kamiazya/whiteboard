import { describe, expect, it } from 'vitest'
import { type FenceHighlighter, FenceTokenMemo } from './fence-tokens.js'
import { FontHandles } from './font-handles.js'
import { LAYOUT_SPATIAL_CANVAS_CAPS } from './generated/input-caps.js'
import { type CoreGlue, coreFrom, EXPECTED_ABI } from './index.js'
import { type LayoutGlue, type LayoutRequest, layoutSpatialCanvas as layoutWith } from './layout.js'

const errors = {
  refused: (operation: string, code: string, detail?: string) =>
    new Error(`${operation} ${code} ${detail ?? ''}`),
}

/** A glue answering `answer`, keeping what it was handed. */
function glueOf(answer: string) {
  const calls: { request: unknown }[] = []
  const glue: LayoutGlue = {
    layout_spatial_canvas(request) {
      calls.push({ request: JSON.parse(request) })
      return answer
    },
    register_layout_fonts: () => '["ok",3]',
    release_layout_fonts: () => true,
    release_layout_cache: () => false,
    layout_query: () => '',
  }
  return { glue, calls }
}

/** The layout over `glue` as a core makes it, with that core's own memo and font handles. */
function layoutSpatialCanvas(
  glue: LayoutGlue,
  layoutErrors: typeof errors,
  request: LayoutRequest,
  highlight?: FenceHighlighter,
  memo = new FenceTokenMemo(),
) {
  return layoutWith(
    glue,
    layoutErrors,
    request,
    highlight,
    memo,
    new FontHandles(glue, layoutErrors),
  )
}

const fake: LayoutRequest = { measure: { kind: 'fake', factor: 0.5 } }

describe('the whole layout over the artifact', () => {
  it('sends the request on the value wire, a font-table measurer by its handle', () => {
    const { glue, calls } = glueOf('["refused","input-too-large","x"]')
    const faces = [{ family: 'A', bold: false, italic: false, bytes: new Uint8Array([1, 2]) }]
    const request = { measure: { kind: 'fonts', faces }, mode: 'light' } as LayoutRequest
    layoutSpatialCanvas(glue, errors, request)
    expect(calls).toEqual([
      { request: ['m', 'measure', ['m', 'kind', 'fonts', 'handle', 3], 'mode', 'light'] },
    ])
    layoutSpatialCanvas(glue, errors, fake)
    expect(calls[1]).toEqual({
      request: ['m', 'measure', ['m', 'kind', 'fake', 'factor', ['f', '3fe0000000000000']]],
    })
  })

  it('reads the layout, its anchors by edge id and its degradations', () => {
    const scene = { nodes: [{ kind: 'glyph', bbox: { x: 0, y: 1, w: 2, h: 3 }, glyph: 'x' }] }
    const anchors = [['e', { fromSide: 'top' }]]
    const events = [{ kind: 'font-missing', family: 'F' }]
    const { glue } = glueOf(JSON.stringify(['ok', scene, anchors, events]))
    const answer = layoutSpatialCanvas(glue, errors, fake)
    expect(answer).toEqual({
      scene,
      anchors: new Map([['e', { fromSide: 'top' }]]),
      degradations: events,
    })
  })

  it('reads the fragment sources a table did not hold, when the answer carries them', () => {
    const asks = [
      { kind: 'math', value: 'x' },
      { kind: 'diagram', lang: 'mermaid', value: 'g' },
    ]
    const { glue } = glueOf(JSON.stringify(['ok', { nodes: [] }, [], [], asks]))
    expect(layoutSpatialCanvas(glue, errors, fake)).toMatchObject({ fragmentsAsked: asks })
    const none = layoutSpatialCanvas(glueOf('["ok",{"nodes":[]},[],[]]').glue, errors, fake)
    expect(none).not.toHaveProperty('fragmentsAsked')
  })

  it('reads a decline as no answer: nothing declines since D7a', () => {
    expect(() => layoutSpatialCanvas(glueOf('["declined","body"]').glue, errors, fake)).toThrow(
      'layout_spatial_canvas malformed answer',
    )
  })

  it('reads a refusal a host draws: a cap passed, a number with no spelling, a silent host', () => {
    const refusals = [
      ['input-too-large', 'too-many-elements'],
      ['input-too-large', 'referenced-elements'],
      ['input-too-large', 'bodies'],
      ['malformed', 'non-finite'],
      ['malformed', 'host-measure'],
    ] as const
    for (const [code, reason] of refusals) {
      const answer = JSON.stringify(['refused', code, reason])
      expect(layoutSpatialCanvas(glueOf(answer).glue, errors, fake), answer).toEqual({
        refused: { code, reason },
      })
    }
    const { glue, calls } = glueOf('[]')
    const big = { ...fake, body: 'x'.repeat(LAYOUT_SPATIAL_CANVAS_CAPS.maxBytes) }
    expect(layoutSpatialCanvas(glue, errors, big)).toEqual({
      refused: { code: 'input-too-large', reason: 'too-large' },
    })
    expect(calls).toEqual([])
  })

  it('refuses a request the wire cannot carry and an answer that is not one', () => {
    const { glue } = glueOf('["ok",{"nodes":[]},[],[]]')
    const unwired = { ...fake, x: undefined, f: () => 1 } as unknown as LayoutRequest
    expect(() => layoutSpatialCanvas(glue, errors, unwired)).toThrow(
      'layout_spatial_canvas malformed wire',
    )
    const garbled = [
      ['["refused","malformed","request"]', 'request'],
      ['["ok",{"nodes":{}},[],[]]', 'answer'],
      ['["ok",[],[],[]]', 'answer'],
      ['["ok",{"nodes":[]},[["e",1]],[]]', 'answer'],
      ['["ok",{"nodes":[]},[[1,{}]],[]]', 'answer'],
      ['["ok",{"nodes":[]},{},[]]', 'answer'],
      ['["ok",{"nodes":[]},[],{}]', 'answer'],
      ['["ok",{"nodes":[]},[],[],{}]', 'answer'],
      ['["ok",{"nodes":[]},[],[],[{"kind":"math"}]]', 'answer'],
      ['["ok",{"nodes":[]},[],[],[{"kind":"diagram","value":"v"}]]', 'answer'],
      ['["ok",{"nodes":[]},[],[],[{"kind":"code","value":"v"}]]', 'answer'],
      ['["ok",{"nodes":[]},[],[],[1]]', 'answer'],
      ['["declined",1]', 'answer'],
      ['{}', 'answer'],
    ] as const
    for (const [answer, detail] of garbled) {
      expect(() => layoutSpatialCanvas(glueOf(answer).glue, errors, fake), answer).toThrow(
        `layout_spatial_canvas malformed ${detail}`,
      )
    }
  })
})

/** A glue answering each call in turn, keeping each request's `codeTokens`. */
function glueAnswering(...answers: string[]) {
  const sent: unknown[] = []
  const glue: LayoutGlue = {
    layout_spatial_canvas(request) {
      const wire = JSON.parse(request) as unknown[]
      const at = wire.indexOf('codeTokens')
      sent.push(at === -1 ? undefined : wire[at + 1])
      return answers[sent.length - 1] ?? '[]'
    },
    register_layout_fonts: () => '[]',
    release_layout_fonts: () => false,
    release_layout_cache: () => false,
    layout_query: () => '',
  }
  return { glue, sent }
}

const OK = '["ok",{"nodes":[]},[],[]]'
const NEEDS = '["needs",{"code":[["js","let x"],["py","a\\nb"]]}]'
const withBody = { ...fake, body: '```js\nlet x\n```\n```py\na\nb\n```' } as LayoutRequest
const tokens = (lang: string, value: string) =>
  lang === 'js' ? [[{ text: value, role: 'keyword' as const }]] : undefined

describe('a fence the core asks for', () => {
  it('is tokenised by the host and sent on one more call', () => {
    const { glue, sent } = glueAnswering(NEEDS, OK)
    const asked: string[] = []
    const highlight = (lang: string, value: string) => {
      asked.push(lang)
      return tokens(lang, value)
    }
    const answer = layoutSpatialCanvas(glue, errors, withBody, highlight)
    expect(answer).toEqual({ scene: { nodes: [] }, anchors: new Map(), degradations: [] })
    expect(asked).toEqual(['js', 'py'])
    expect(sent).toEqual([
      undefined,
      [
        's',
        ['s', 'js', 'let x', ['s', ['s', ['m', 'text', 'let x', 'role', 'keyword']]]],
        ['s', 'py', 'a\nb', null],
      ],
    ])
  })

  it('throws for a layout with no highlighter, or when the core asks twice: a defect, not an input', () => {
    expect(() => layoutSpatialCanvas(glueAnswering(NEEDS, OK).glue, errors, withBody)).toThrow(
      'layout_spatial_canvas malformed highlight',
    )
    const twice = glueAnswering(NEEDS, NEEDS, OK)
    expect(() => layoutSpatialCanvas(twice.glue, errors, withBody, tokens)).toThrow(
      'layout_spatial_canvas malformed highlight',
    )
    expect(twice.sent).toHaveLength(2)
  })

  it('draws a fence the highlighter throws on plain', () => {
    const { glue, sent } = glueAnswering('["needs",{"code":[["js","x"]]}]', OK)
    const throwing = () => {
      throw new Error('grammar')
    }
    layoutSpatialCanvas(glue, errors, withBody, throwing)
    expect(sent[1]).toEqual(['s', ['s', 'js', 'x', null]])
  })

  it('reads a needs answer that is not one as no answer', () => {
    for (const bad of ['["needs",{"code":[["js"]]}]', '["needs",{"code":3}]', '["needs",[]]']) {
      expect(
        () => layoutSpatialCanvas(glueAnswering(bad).glue, errors, withBody, tokens),
        bad,
      ).toThrow('layout_spatial_canvas malformed answer')
    }
  })

  it('refuses a second call the tokens carry past the cap', () => {
    const big = { ...fake, body: 'x'.repeat(LAYOUT_SPATIAL_CANVAS_CAPS.maxBytes - 200) }
    const { glue, sent } = glueAnswering(`["needs",{"code":[["js","${'y'.repeat(300)}"]]}]`, OK)
    expect(layoutSpatialCanvas(glue, errors, big as LayoutRequest, tokens)).toEqual({
      refused: { code: 'input-too-large', reason: 'too-large' },
    })
    expect(sent).toHaveLength(1)
  })
})

describe('the fence tokens a core keeps', () => {
  it('sends a fence it holds on the first call, so the layout is one call', () => {
    const memo = new FenceTokenMemo()
    layoutSpatialCanvas(glueAnswering(NEEDS, OK).glue, errors, withBody, tokens, memo)
    const again = glueAnswering(OK)
    const asked: string[] = []
    const highlight = (lang: string, value: string) => {
      asked.push(lang)
      return tokens(lang, value)
    }
    layoutSpatialCanvas(again.glue, errors, withBody, highlight, memo)
    expect(asked).toEqual([])
    expect(again.sent).toEqual([
      [
        's',
        ['s', 'js', 'let x', ['s', ['s', ['m', 'text', 'let x', 'role', 'keyword']]]],
        ['s', 'py', 'a\nb', null],
      ],
    ])
    const other = glueAnswering(OK)
    layoutSpatialCanvas(
      other.glue,
      errors,
      { ...fake, body: 'let x' } as LayoutRequest,
      tokens,
      memo,
    )
    expect(other.sent).toEqual([
      ['s', ['s', 'js', 'let x', ['s', ['s', ['m', 'text', 'let x', 'role', 'keyword']]]]],
    ])
  })

  it('answers a fence it holds without the highlighter', () => {
    const memo = new FenceTokenMemo()
    memo.answer([['js', 'v']], tokens)
    expect(memo.answer([['js', 'v']], () => undefined)).toEqual([
      ['js', 'v', [[{ text: 'v', role: 'keyword' }]]],
    ])
  })

  it('forgets the fence used least recently past its count or its size', () => {
    const memo = new FenceTokenMemo(2, 10)
    memo.answer(
      [
        ['a', '1'],
        ['b', '2'],
        ['c', '3'],
      ],
      () => undefined,
    )
    expect(memo.within('1 2 3').map(([lang]) => lang)).toEqual(['b', 'c'])
    memo.within('2')
    memo.answer([['d', '4']], () => undefined)
    expect(memo.within('1 2 3 4').map(([lang]) => lang)).toEqual(['b', 'd'])
    memo.answer([['e', '1234567890']], () => undefined)
    expect(memo.within('2 4 1234567890').map(([lang]) => lang)).toEqual(['e'])
  })

  it('keeps one table per highlighter, so a core draws a fence as the call highlights it', () => {
    const { glue: layout, sent } = glueAnswering(NEEDS, OK, NEEDS, OK)
    const glue: CoreGlue = {
      initSync: () => undefined,
      abi_version: () => EXPECTED_ABI,
      edge_route_layout: () => new Float64Array(),
      okf_parse: () => '',
      okf_serialize: () => '',
      json_canvas_parse: () => '',
      json_canvas_serialize: () => '',
      facet_bucket_check: () => '',
      layout_spatial_canvas: (request) => layout.layout_spatial_canvas(request),
      register_layout_fonts: () => '[]',
      release_layout_fonts: () => false,
      release_layout_cache: () => false,
      layout_query: () => '',
    }
    const core = coreFrom(glue, new Uint8Array())
    core.layoutSpatialCanvas(withBody, tokens)
    core.layoutSpatialCanvas(withBody, () => undefined)
    expect(sent[2], 'the second highlighter is sent nothing the first answered').toBeUndefined()
    expect(sent[3]).toEqual(['s', ['s', 'js', 'let x', null], ['s', 'py', 'a\nb', null]])
  })
})
