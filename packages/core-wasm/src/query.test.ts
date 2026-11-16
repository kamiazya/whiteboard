import { describe, expect, it } from 'vitest'
import { FenceTokenMemo } from './fence-tokens.js'
import { FontHandles } from './font-handles.js'
import type { LayoutGlue } from './layout.js'
import { type LayoutQueryRequest, layoutQuery } from './query.js'

const errors = {
  refused: (operation: string, code: string, detail?: string) =>
    new Error(`${operation} ${code} ${detail ?? ''}`),
}

/** A glue whose query export answers from `answers` in turn, keeping what it was handed. */
function glueOf(...answers: string[]) {
  const sent: unknown[] = []
  const glue: LayoutGlue = {
    layout_spatial_canvas: () => '["declined","whole layout"]',
    register_layout_fonts: () => '["ok",3]',
    release_layout_fonts: () => true,
    release_layout_cache: () => false,
    layout_query(request) {
      sent.push(JSON.parse(request))
      return answers[sent.length - 1] ?? '["declined","x"]'
    },
  }
  return { glue, sent }
}

const ask = (glue: LayoutGlue, request: LayoutQueryRequest, highlight?: () => undefined) =>
  layoutQuery(
    { glue, errors, highlight, memo: new FenceTokenMemo(), fonts: new FontHandles(glue, errors) },
    request,
    undefined,
  )

const hex = (n: number) => {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, n)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}

const box = { query: 'outline-content-box', box: [0, 0, 10, 10] } as const

describe('a query over the artifact', () => {
  it('sends a geometry query on the value wire to the query export, and reads its doubles from their bits', () => {
    const answer = JSON.stringify(['ok', [hex(1.5), hex(-0), hex(Number.NaN), hex(-Infinity)]])
    const { glue, sent } = glueOf(answer)
    const got = ask(glue, { ...box, shape: 'visual.ellipse' })
    expect(sent).toEqual([
      ['m', 'query', 'outline-content-box', 'box', ['s', 0, 0, 10, 10], 'shape', 'visual.ellipse'],
    ])
    expect(got).toEqual({ numbers: [[1.5, -0, Number.NaN, -Infinity]] })
    expect(Object.is((got as { numbers: number[][] }).numbers[0]?.[1], -0)).toBe(true)
  })

  it('reads an edge layer and its degradations, and sends a measured query through the layout calls', () => {
    const nodes = [{ kind: 'edge', id: 'e', path: [] }]
    const events = [{ kind: 'font-missing', family: 'Yomogi' }]
    const { glue, sent } = glueOf(JSON.stringify(['ok', nodes, events]))
    const request = {
      query: 'edges',
      measure: { kind: 'fake', factor: 0.6 },
      canvas: { nodes: [], edges: [] },
    } as const
    expect(ask(glue, request)).toEqual({ nodes, degradations: events })
    expect(sent[0]).toEqual(
      expect.arrayContaining([
        'query',
        'edges',
        'measure',
        ['m', 'kind', 'fake', 'factor', ['f', hex(0.6)]],
      ]),
    )
  })

  it('sends the fences a measured query asks for, tokenised, on a second call', () => {
    const needs = JSON.stringify(['needs', { code: [['ts', 'x']] }])
    const { glue, sent } = glueOf(needs, JSON.stringify(['ok', [hex(42)]]))
    const request = { query: 'node-size', measure: { kind: 'ratio' } } as const
    const got = layoutQuery(
      {
        glue,
        errors,
        highlight: () => [[{ text: 'x' }]],
        memo: new FenceTokenMemo(),
        fonts: new FontHandles(glue, errors),
      },
      request,
      undefined,
    )
    expect(got).toEqual({ numbers: [[42]] })
    expect(JSON.stringify(sent[1])).toContain('"codeTokens"')
    // Without a highlighter the fences cannot be sent, and the TypeScript answers.
    expect(ask(glueOf(needs).glue, request)).toEqual({ declined: 'highlight' })
  })

  it('answers a decline or a refusal past a cap as declined, and throws on anything else', () => {
    expect(ask(glueOf('["declined","body"]').glue, box)).toEqual({ declined: 'body' })
    const past = '["refused","input-too-large","runs"]'
    expect(ask(glueOf(past).glue, box)).toEqual({ declined: 'runs' })
    expect(() => ask(glueOf('["refused","malformed","request"]').glue, box)).toThrow(
      'layout_query malformed request',
    )
    expect(() => ask(glueOf('["ok",["zz"]]').glue, box)).toThrow('layout_query malformed answer')
    const edges = { query: 'edges', measure: { kind: 'ratio' } } as const
    expect(() => ask(glueOf('["ok",[]]').glue, edges)).toThrow('layout_query malformed answer')
  })

  it("declines a geometry query past the entry's bytes without calling it", () => {
    const { glue, sent } = glueOf()
    const huge = { ...box, shape: 'x'.repeat(5 * 1024 * 1024) }
    expect(ask(glue, huge)).toEqual({ declined: 'too-large' })
    expect(sent).toEqual([])
  })
})
