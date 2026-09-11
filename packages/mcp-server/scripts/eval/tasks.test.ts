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
type Edge = { id: string; fromNode: string; toNode: string }
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
  nodes: LABELS.map(([id, text], i) => ({
    id,
    type: 'text',
    text,
    x: i * 300,
    y: 0,
    width: 200,
    height: 80,
  })),
  edges: FLOWS.map(([from, to], i) => ({ id: `e${i}`, fromNode: from, toNode: to })),
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
      fromNode: e.fromNode === 'payments' ? 'orders' : e.fromNode,
      toNode: e.toNode === 'payments' ? 'orders' : e.toNode,
    }))
    await expect(verify(board)).resolves.toMatchObject({ ok: false })
  })

  it('refuses a board whose arrows run against the flow the prompt describes', async () => {
    // The prompt says a Shopper HITS the gateway and the gateway CALLS the
    // services. A board drawn with every arrow reversed is a different
    // claim about the system, not a stylistic difference.
    const board = goodBoard()
    board.edges = board.edges.map((e) => ({ ...e, fromNode: e.toNode, toNode: e.fromNode }))
    await expect(verify(board)).resolves.toMatchObject({ ok: false })
  })

  it('names a box it wants and cannot find, rather than throwing', async () => {
    const board = goodBoard()
    board.nodes = board.nodes.filter((n) => n.id !== 'stripe')
    board.edges = board.edges.filter((e) => e.toNode !== 'stripe')
    await expect(verify(board)).resolves.toEqual({ ok: false, detail: 'missing: Stripe' })
  })
})
