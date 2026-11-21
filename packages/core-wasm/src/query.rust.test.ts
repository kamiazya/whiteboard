import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadCore } from './load.js'

/**
 * Each query through the shim over the built artifact: the measured ones
 * through the layout calls, a host-measured one through the core's import, and
 * the geometry ones in one call. What each answers is held to the TypeScript by
 * canvas-render's replay of the query recordings through its switch.
 */

// Built, not committed: a name the relative-import scan reads as a file that
// must exist would fail every job that has no wasm build.
const WASM = 'whiteboard_wasm_bg.wasm'
const bytes = () => readFileSync(new URL(`../artifacts/${WASM}`, import.meta.url))

const box = (id: string, x: number) => ({
  id,
  x,
  y: 0,
  width: 120,
  height: 60,
  resource: { mimeType: 'text/markdown', content: id },
})
const canvas = {
  nodes: [box('a', 0), box('b', 300)],
  edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' }, label: 'flows' }],
}

describe('the queries through the shim over the built artifact', () => {
  it('lays out an edge layer, measured by the host when the request names it', async () => {
    const core = await loadCore(bytes())
    const request = { query: 'edges', canvas, mode: 'light', expand: false } as const
    const faked = core.layoutQuery({ ...request, measure: { kind: 'fake', factor: 0.6 } })
    expect('nodes' in faked && faked.nodes.map((n) => n.kind)).toEqual(['edge', 'textRun'])
    const asked: string[] = []
    const hosted = core.layoutQuery(
      { ...request, measure: { kind: 'host' } },
      undefined,
      (text) => {
        asked.push(text)
        return { advanceWidth: 6 * text.length, ascent: 8, descent: 2, lineGap: 0 }
      },
    )
    expect('nodes' in hosted, JSON.stringify(hosted)).toBe(true)
    expect(asked).toContain('flows')
  })

  it('tidies a board and answers only the boxes that move', async () => {
    const core = await loadCore(bytes())
    const request = {
      query: 'tidy',
      nodes: [
        ['a', false, 0, 0, 100, 40],
        ['b', false, 200, 3, 100, 40],
      ],
      locked: [],
    } as const
    expect(core.layoutQuery(request)).toEqual({ moves: [['b', 200, 0]] })
  })

  it('digests the scene a canvas lays out without sending the scene back', async () => {
    const core = await loadCore(bytes())
    const request = {
      query: 'scene-digest',
      canvas,
      mode: 'light',
      expand: false,
      measure: { kind: 'fake', factor: 0.6 },
    } as const
    const answered = core.layoutQuery(request)
    expect('digest' in answered, JSON.stringify(answered)).toBe(true)
    const digest = JSON.parse((answered as { digest: string }).digest)
    expect(digest.nodes.map((n: { id: string }) => n.id)).toEqual(['a', 'b'])
  })

  it('sizes a node, asking for its fence tokens on a second call', async () => {
    const core = await loadCore(bytes())
    const node = {
      ...box('n', 0),
      resource: { mimeType: 'text/markdown', content: '```ts\nlet x = 1\n```' },
    }
    const measure = { kind: 'fake', factor: 0.6 } as const
    const request = { query: 'node-size', node, measure, mode: 'dark', floor: 'none' } as const
    expect(() => core.layoutQuery(request)).toThrow(
      'layout_query refused its input: malformed (highlight)',
    )
    const sized = core.layoutQuery(request, () => [[{ text: 'let x = 1' }]])
    expect('numbers' in sized && sized.numbers).toEqual([[expect.any(Number)]])
  })

  it('answers the geometry queries in one call each', async () => {
    const core = await loadCore(bytes())
    const placed = core.layoutQuery({
      query: 'label-placement',
      path: [
        [0, 0],
        [100, 0],
      ],
      size: [10, 10],
      obstacles: [],
      rounded: false,
    })
    expect(placed).toEqual({ numbers: [[50, 0]] })
    const bubble = core.layoutQuery({
      query: 'comment-bubble',
      anchor: [0, 0],
      size: [100, 40],
      obstacles: [],
    })
    expect('numbers' in bubble && bubble.numbers[0]).toHaveLength(4)
    const titles = core.layoutQuery({
      query: 'label-obstacles',
      nodes: canvas.nodes,
      runs: [['node', 'a', [0, -20, 40, 16]]],
    })
    expect(titles).toEqual({
      numbers: [
        [],
        [
          [0, 0, 120, 60],
          [300, 0, 120, 60],
        ],
      ],
    })
    const inner = core.layoutQuery({ query: 'outline-content-box', box: [0, 0, 10, 10] })
    expect(inner).toEqual({ numbers: [[0, 0, 10, 10]] })
  })

  it('answers a query over boxes whose body holds a lone surrogate as it does with U+FFFD in its place', async () => {
    const core = await loadCore(bytes())
    const ask = (content: string) =>
      core.layoutQuery({
        query: 'label-obstacles',
        nodes: [{ ...box('a', 0), resource: { mimeType: 'text/markdown', content } }],
        runs: [['node', 'a', [0, -20, 40, 16]]],
      })

    const drawn = ask('before \ud800 after')

    expect('numbers' in drawn, JSON.stringify(drawn)).toBe(true)
    expect(drawn).toEqual(ask('before \ufffd after'))
  })

  it('lays out an edge layer whose canvas holds a lone surrogate in a body or a label', async () => {
    const core = await loadCore(bytes())
    const ask = (text: string) => {
      const request = {
        query: 'edges',
        canvas: {
          nodes: canvas.nodes,
          edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' }, label: text }],
        },
        mode: 'light',
        expand: false,
      } as const
      return core.layoutQuery({ ...request, measure: { kind: 'fake', factor: 0.6 } })
    }

    const drawn = ask('flows \ud800')

    expect('nodes' in drawn, JSON.stringify(drawn)).toBe(true)
    expect(drawn).toEqual(ask('flows \ufffd'))
  })
})
