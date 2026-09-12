// The lane's VERIFIERS are an instrument, and nothing checked them until a
// review found two ways the kinds task passes a board it should refuse.
//
// That gap matters more here than in most scripts: a verifier's verdict is
// what the ADR readings are built from, so a wrong one does not merely fail
// a run, it publishes a number. The same increment this file arrives in
// corrected two other instrument defects that no test could see.
//
// Only the kinds task is covered. A verifier earns a case here when
// something about it has been got wrong, not on principle — every task in
// the file would be a fixture pile that nobody reads.
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { TASKS } from './tasks.mjs'

const KINDS = TASKS.find((t) => t.name === 'draw a flow whose kinds are told apart at a glance')

type Node = {
  id: string
  type: string
  text: string
  x: number
  y: number
  width: number
  height: number
}
// An END is an object, not a flat key (ADR-0037 slice 3). Spelled out here
// rather than imported because this fixture stands in for what the snapshot
// hands a verifier, and a fixture that drifts from that shape is how a
// POSITIVE control stops controlling anything.
type End = { kind: 'node'; node: string }
type Edge = { id: string; from: End; to: End }
const at = (node: string): End => ({ kind: 'node', node })
type Board = { nodes: Node[]; edges: Edge[] }

/** A board the fixture agent would be passed for `boards/checkout`. */
const wbFor = (board: Board) => ({
  call: async (name: string) => {
    if (name === 'wb_document_list') {
      return { documents: [{ path: 'boards/checkout', documentId: 'doc-1' }] }
    }
    if (name === 'wb_canvas_snapshot') return board
    throw new Error(`the verifier called an unexpected tool: ${name}`)
  },
})

const LABELS = [
  ['shopper', 'Shopper'],
  ['gateway', 'API Gateway'],
  ['orders', 'Orders Service'],
  ['payments', 'Payments Service'],
  ['postgres', 'Postgres'],
  ['events', 'Events Queue'],
  ['stripe', 'Stripe'],
] as const

const FLOWS = [
  ['shopper', 'gateway'],
  ['gateway', 'orders'],
  ['gateway', 'payments'],
  ['orders', 'postgres'],
  ['orders', 'events'],
  ['payments', 'stripe'],
] as const

/** Seven boxes in a row, no overlaps, every flow in the prompt's direction. */
const goodBoard = (): Board => ({
  nodes: LABELS.map(([id, text], i) =>
    textNode({ id, text, x: i * 300, y: 0, width: 200, height: 80 }),
  ),
  edges: FLOWS.map(([from, to], i) => ({ id: `e${i}`, from: at(from), to: at(to) })),
})

const verify = (board: Board) => KINDS?.verify?.(wbFor(board) as never, {} as never)

describe('the kinds task verifier', () => {
  it('passes a board with all seven boxes, every flow, and no overlap', async () => {
    await expect(verify(goodBoard())).resolves.toEqual({
      ok: true,
      detail: '7 boxes, 6 flows, no overlap',
    })
  })

  it('matches a distinctive word, so a wrapped or elaborated label still counts', async () => {
    // Why the list holds `gateway` rather than `API gateway`: a model wrapped
    // the label and the phrase stopped matching, so the lane reported a
    // missing box for a box that was there.
    const board = goodBoard()
    const gateway = board.nodes.find((n) => n.id === 'gateway')
    if (gateway !== undefined) gateway.text = 'API\nGateway'
    await expect(verify(board)).resolves.toMatchObject({ ok: true })
  })

  it('refuses a board where one box answers for two of the kinds', async () => {
    // `nodes.find()` per word can return the SAME node twice, and the detail
    // then claims seven boxes over six. Six kinds drawn as six boxes is not
    // the drawing the prompt asked for, whatever the labels add up to.
    const board = goodBoard()
    board.nodes = board.nodes.filter((n) => n.id !== 'payments')
    const orders = board.nodes.find((n) => n.id === 'orders')
    if (orders !== undefined) orders.text = 'Orders Payments Service'
    board.edges = board.edges.map((e) => ({
      ...e,
      from: e.from.node === 'payments' ? at('orders') : e.from,
      to: e.to.node === 'payments' ? at('orders') : e.to,
    }))
    await expect(verify(board)).resolves.toMatchObject({ ok: false })
  })

  it('refuses a board whose arrows run against the flow the prompt describes', async () => {
    // The prompt says a Shopper HITS the gateway and the gateway CALLS the
    // services. A board drawn with every arrow reversed is a different
    // claim about the system, not a stylistic difference.
    const board = goodBoard()
    board.edges = board.edges.map((e) => ({ ...e, from: e.to, to: e.from }))
    await expect(verify(board)).resolves.toMatchObject({ ok: false })
  })

  it('names a box it wants and cannot find, rather than throwing', async () => {
    const board = goodBoard()
    board.nodes = board.nodes.filter((n) => n.id !== 'stripe')
    board.edges = board.edges.filter((e) => e.to.node !== 'stripe')
    await expect(verify(board)).resolves.toEqual({ ok: false, detail: 'missing: Stripe' })
  })
})

describe('the workspace-vocabulary verifier', () => {
  // Earns its cases the way this file's header asks: not on principle, but
  // because the verifier was WRITTEN around a specific way of being wrong.
  // Grading a stencil by the box's COLOUR is the obvious shortcut and it
  // passes the wrong board — `visual.gateway` is colour 3 and so is this
  // workspace's `lakehouse`. What stops a later simplification back to that
  // is a test that fails on it.
  const DRESS = TASKS.find((t) => t.name === 'dress a box with a style this workspace defines')

  /** The document the verifier reads, with one box dressed however given. */
  const wbWith = (node: Record<string, unknown> | undefined) => ({
    call: async (name: string) => {
      if (name !== 'wb_document_get') {
        throw new Error(`the verifier called an unexpected tool: ${name}`)
      }
      return {
        documents: [
          {
            content: JSON.stringify({ nodes: node === undefined ? [] : [node], edges: [] }),
          },
        ],
      }
    },
  })

  const dressed = (stencil: string | undefined, color: string) => ({
    id: 'lake',
    type: 'text',
    text: 'Events lake',
    x: 0,
    y: 0,
    width: 200,
    height: 80,
    color,
    ...(stencil === undefined
      ? {}
      : { 'x-whiteboard': { facets: { 'visual.stencil/v0': { stencil } } } }),
  })

  const verify = (node: Record<string, unknown> | undefined) =>
    DRESS!.verify!(wbWith(node) as never, { 'boards/architecture': 'doc-1' } as never)

  it('passes a box wearing the stencil this workspace defines', async () => {
    await expect(verify(dressed('workspace.lakehouse', '3'))).resolves.toMatchObject({ ok: true })
  })

  it('refuses a BUILT-IN stencil of the same colour, which a colour check would pass', async () => {
    // The whole reason the verifier reads the stored facet. `visual.gateway`
    // is colour 3, so a box dressed with it is indistinguishable from the
    // right answer by appearance alone — and it is the plausible wrong
    // answer, since a model that never found the library still has to dress
    // the box with something.
    await expect(verify(dressed('visual.gateway', '3'))).resolves.toMatchObject({ ok: false })
    await expect(verify(dressed('visual.datastore', '5'))).resolves.toMatchObject({ ok: false })
  })

  it('refuses a box coloured by hand, and says it wears no stencil', async () => {
    await expect(verify(dressed(undefined, '3'))).resolves.toEqual({
      ok: false,
      detail: 'the box wears no stencil at all',
    })
  })

  it('names the missing box rather than throwing on an untouched board', async () => {
    await expect(verify(undefined)).resolves.toMatchObject({ ok: false })
  })
})
