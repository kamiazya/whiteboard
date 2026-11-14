import { describe, expect, it } from 'vitest'
import { LAYOUT_SPATIAL_CANVAS_CAPS } from './generated/input-caps.js'
import { type LayoutGlue, type LayoutRequest, layoutSpatialCanvas } from './layout.js'

const errors = {
  refused: (operation: string, code: string, detail?: string) =>
    new Error(`${operation} ${code} ${detail ?? ''}`),
}

/** A glue answering `answer`, keeping what it was handed. */
function glueOf(answer: string) {
  const calls: { request: unknown; fonts: number[] }[] = []
  const glue: LayoutGlue = {
    layout_spatial_canvas(request, fonts) {
      calls.push({ request: JSON.parse(request), fonts: [...fonts] })
      return answer
    },
  }
  return { glue, calls }
}

const fake: LayoutRequest = { measure: { kind: 'fake', factor: 0.5 } }

describe('the whole layout over the artifact', () => {
  it('sends the request on the value wire and the faces as one array they point into', () => {
    const { glue, calls } = glueOf('["declined","x"]')
    const faces = [
      { family: 'A', bold: false, italic: false, bytes: new Uint8Array([1, 2]) },
      { family: 'A', bold: true, italic: true, bytes: new Uint8Array([3, 4, 5]) },
    ]
    const request = { measure: { kind: 'fonts', faces }, mode: 'light' } as LayoutRequest
    layoutSpatialCanvas(glue, errors, request)
    expect(calls).toEqual([
      {
        request: [
          'm',
          'measure',
          [
            'm',
            'kind',
            'fonts',
            'faces',
            [
              's',
              ['m', 'family', 'A', 'bold', false, 'italic', false, 'from', 0, 'to', 2],
              ['m', 'family', 'A', 'bold', true, 'italic', true, 'from', 2, 'to', 5],
            ],
          ],
          'mode',
          'light',
        ],
        fonts: [1, 2, 3, 4, 5],
      },
    ])
    layoutSpatialCanvas(glue, errors, fake)
    expect(calls[1]).toEqual({
      request: ['m', 'measure', ['m', 'kind', 'fake', 'factor', ['f', '3fe0000000000000']]],
      fonts: [],
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

  it('declines what the core declined and a request past the cap', () => {
    expect(layoutSpatialCanvas(glueOf('["declined","shortcode"]').glue, errors, fake)).toEqual({
      declined: 'shortcode',
    })
    const tooMany = '["refused","input-too-large","too-many-elements"]'
    expect(layoutSpatialCanvas(glueOf(tooMany).glue, errors, fake)).toEqual({
      declined: 'too-many-elements',
    })
    const { glue, calls } = glueOf('[]')
    const big = { ...fake, body: 'x'.repeat(LAYOUT_SPATIAL_CANVAS_CAPS.maxBytes) }
    expect(layoutSpatialCanvas(glue, errors, big)).toEqual({ declined: 'too-large' })
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
