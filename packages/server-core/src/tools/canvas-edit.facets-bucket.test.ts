// A facets bucket an op WRITES is refused when malformed, for every op that
// carries one. The stored edge and line fields tolerate a bad bucket on read
// (`.catch(undefined)`) so a canvas stays readable; borrowing that schema for
// the write dropped the bucket a caller just sent, with the call reporting
// success.
import { describe, expect, test } from 'vitest'
import { canvasEditInputSchema } from './canvas-edit.js'

const node = (id: string) => ({ kind: 'node', node: id })
const edgeEnd = (id: string) => ({ node: id })

const OPS: Record<string, (facets: unknown) => Record<string, unknown>> = {
  'node.add': (facets) => ({ op: 'node.add', node: { type: 'text', text: 'x', facets } }),
  'edge.add': (facets) => ({
    op: 'edge.add',
    edge: { from: edgeEnd('a'), to: edgeEnd('b'), facets },
  }),
  'edge.patch': (facets) => ({ op: 'edge.patch', id: 'e1', patch: { facets } }),
  'line.add': (facets) => ({
    op: 'line.add',
    line: { from: node('a'), to: node('b'), facets },
  }),
  'line.patch': (facets) => ({ op: 'line.patch', id: 'l1', patch: { facets } }),
}

const parse = (op: Record<string, unknown>) =>
  canvasEditInputSchema.safeParse({
    workspaceId: 'ws-1',
    documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7',
    mode: 'apply',
    ops: [op],
  })

describe('wb_canvas_edit — a malformed facets bucket on an op', () => {
  test('the ops under test are all of the facet-carrying element ops', () => {
    expect(Object.keys(OPS)).toEqual([
      'node.add',
      'edge.add',
      'edge.patch',
      'line.add',
      'line.patch',
    ])
  })

  describe.each(Object.entries(OPS))('%s', (_name, build) => {
    test.each([
      ['a number', 5],
      ['a string', 'x'],
      ['an array', [1]],
      ['a key that is not {namespace}.{name}/v{n}', { nope: {} }],
    ])('refuses %s', (_what, facets) => {
      expect(parse(build(facets)).success).toBe(false)
    })

    test('keeps a well-formed bucket, null tombstones included', () => {
      const facets = { 'example.sample/v1': { status: 'open' }, 'example.gone/v1': null }
      const parsed = parse(build(facets))
      expect(parsed.success).toBe(true)
      const op = parsed.data?.ops[0] as Record<string, any>
      const carried = (op.node ?? op.edge ?? op.line ?? op.patch).facets
      expect(carried).toEqual(facets)
    })
  })
})
