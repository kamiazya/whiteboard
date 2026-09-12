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
import { type EdgeEnd, edgeEndSchema } from '@kamiazya/whiteboard-model'
import { applyStencil } from '@kamiazya/whiteboard-plugin-visual'
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
// An END is an object, not a flat key (ADR-0037 slice 3), and it is BUILT
// THROUGH the model's own schema rather than spelled out here.
//
// The previous version of this line spelled it out, under a comment warning
// that "a fixture that drifts from that shape is how a POSITIVE control stops
// controlling anything" — and then did exactly that. ADR-0038 decision 2
// narrowed an edge end from a `{ kind: 'node', node }` union to a plain
// `{ node, side?, end? }`, because an edge is a relation and cannot end in
// empty space. The hand-written fixture did not move, so every test below
// kept passing against a shape no tool answers any more, while the real lane
// failed 6 of 6 trials with "not connected" on boards whose edges were
// written with zero tool errors.
//
// `.parse` rather than a cast, and `edgeEndSchema` is `.strict()`: a fixture
// carrying a key the schema retired now THROWS here instead of quietly
// standing in for a payload nobody sends.
type End = EdgeEnd
type Edge = { id: string; from: End; to: End }
const at = (node: string): End => edgeEndSchema.parse({ node })
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
  // passes the wrong board. It did when this was written, because
  // `visual.gateway` was colour 3 and so is this workspace's `lakehouse`;
  // since ADR-0036 §5 no bundled stencil carries a colour at all, so the
  // shortcut is worse still. What stops a later simplification back to it is
  // a test that fails on it.
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
    // The whole reason the verifier reads the stored facet. The colour is
    // supplied here by hand — no bundled stencil writes one since ADR-0036
    // §5 — so a box dressed with a built-in is indistinguishable from the
    // right answer by appearance alone, and it is the plausible wrong
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

describe('the two-axis verifier', () => {
  // A NEW verifier with a grading rule nothing else uses — two channels, each
  // carrying a DIFFERENT declared distinction — so it gets a positive control
  // on arrival rather than after something goes wrong with it. `--dry-run`
  // proves only that it refuses an empty fixture; what a verifier grading by
  // an instrument can also do is refuse EVERY board, and that reads the same.
  const FLEET = TASKS.find((t) => t.name.startsWith('tell two things apart'))

  type Box = { id: string; label: string; stencil: string; status: string; color: string }
  const FLEET_BOXES: readonly Box[] = [
    {
      id: 'orders',
      label: 'Orders service',
      stencil: 'visual.service',
      status: 'healthy',
      color: '4',
    },
    {
      id: 'billing',
      label: 'Billing service',
      stencil: 'visual.service',
      status: 'failing',
      color: '1',
    },
    { id: 'pg', label: 'Postgres', stencil: 'visual.datastore', status: 'healthy', color: '4' },
    {
      id: 'redis',
      label: 'Redis cache',
      stencil: 'visual.datastore',
      status: 'failing',
      color: '1',
    },
    {
      id: 'pay',
      label: 'Payment gateway',
      stencil: 'visual.external',
      status: 'healthy',
      color: '4',
    },
  ]

  /**
   * A dressed box's facets, EXPANDED BY THE REAL STENCIL CODE rather than
   * written out here.
   *
   * The first version of this fixture wrote `visual.stencil/v0` by hand and
   * stopped there, and the positive control failed with `shape unused` —
   * applying a stencil also writes `visual.shape/v0`, which is the facet the
   * shape CHANNEL is read from. A hand-written stand-in for what a tool
   * produces is exactly the drift `snapshot-shape.test.ts` was built to
   * catch, and it was reproduced here within the hour of landing that guard.
   */
  const dressed = (stencil: string, status: string) => {
    const node = applyStencil(
      { id: 'x', type: 'text', text: '', x: 0, y: 0, width: 200, height: 80 } as never,
      stencil,
    )
    if (node === undefined) throw new Error(`no such bundled stencil: ${stencil}`)
    return { ...(node.facets ?? {}), 'ops.status/v0': { status } }
  }

  /** The JSON Canvas projection `wb_document_get` answers, with facets. */
  const fleetContent = (boxes: readonly Box[], axes: readonly string[]) =>
    JSON.stringify({
      nodes: boxes.map((b, i) => ({
        id: b.id,
        type: 'text',
        text: b.label,
        x: i * 300,
        y: 0,
        width: 200,
        height: 80,
        color: b.color,
        'x-whiteboard': { facets: dressed(b.stencil, b.status) },
      })),
      edges: [],
      'x-whiteboard': { facets: { 'visual.axes/v0': { axes: [...axes] } } },
    })

  const wbOver = (content: string) => ({
    call: async (name: string) => {
      if (name === 'wb_document_list') {
        return { documents: [{ path: 'boards/fleet', documentId: 'doc-1' }] }
      }
      if (name === 'wb_document_get') return { documents: [{ content }] }
      if (name === 'wb_canvas_snapshot') return JSON.parse(content)
      throw new Error(`the verifier called an unexpected tool: ${name}`)
    },
  })

  const verify = (content: string) => FLEET?.verify?.(wbOver(content) as never, {} as never)

  it('passes a board whose colour carries a DECLARED axis and whose shape carries the stencil', async () => {
    await expect(verify(fleetContent(FLEET_BOXES, ['ops.status/v0']))).resolves.toMatchObject({
      ok: true,
    })
  })

  it('refuses the same board with the axis undeclared, which is the whole point', async () => {
    // Identical pixels. The only difference is that nothing records what the
    // colour means, so only whoever drew it can read it — ADR-0033's
    // `contested`, and the defect the axis declaration exists to end.
    await expect(verify(fleetContent(FLEET_BOXES, []))).resolves.toMatchObject({ ok: false })
  })

  it('refuses a board where both channels say the same thing', async () => {
    // Colour follows the stencil exactly, so the second question — is it
    // healthy? — is drawn by nothing, and the board answers one question
    // twice. `carried` on both channels would pass a weaker rule.
    const perStencil: Record<string, string> = {
      'visual.service': '4',
      'visual.datastore': '5',
      'visual.external': '6',
    }
    const boxes = FLEET_BOXES.map((b) => ({ ...b, color: perStencil[b.stencil] as string }))
    await expect(verify(fleetContent(boxes, ['ops.status/v0']))).resolves.toMatchObject({
      ok: false,
    })
  })

  it('refuses a board missing one of the things the prompt asked for', async () => {
    const content = fleetContent(
      FLEET_BOXES.filter((b) => b.id !== 'redis'),
      ['ops.status/v0'],
    )
    await expect(verify(content)).resolves.toMatchObject({ ok: false, detail: 'missing: Redis' })
  })
})
