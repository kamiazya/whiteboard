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
import { claimMessageNodes, endNode, linked, linkedFrom, TASKS } from './tasks.mjs'

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
  // The WIRE shape `wb_canvas_snapshot` answers with, which is what the
  // verifier reads — `type` plus `text`, not the model's resource. Frozen by
  // ADR-0031 and deliberately unmoved by ADR-0038 decision 3, so a fixture
  // built with the model's node builders would be testing the wrong contract.
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

  type Box = { id: string; label: string; stencil: string; status: string; color?: string }
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

  /**
   * The same box, its health recorded as a SCOPED TAG (ADR-0040): the key
   * `health` partitions the boxes with no declaration, which is the reading
   * `semantic.class/v0` used to have and no longer does.
   */
  const healthTag = (status: string) => [`health:${status}`]

  /** The JSON Canvas projection `wb_document_get` answers, with facets. */
  const fleetContent = (
    boxes: readonly Box[],
    axes: readonly string[],
    tagsOf?: (status: string) => readonly string[],
  ) =>
    JSON.stringify({
      nodes: boxes.map((b, i) => ({
        id: b.id,
        type: 'text',
        text: b.label,
        x: i * 300,
        y: 0,
        width: 200,
        height: 80,
        ...(b.color === undefined ? {} : { color: b.color }),
        'x-whiteboard': {
          facets: dressed(b.stencil, b.status),
          ...(tagsOf === undefined ? {} : { tags: tagsOf(b.status) }),
        },
      })),
      edges: [],
      'x-whiteboard': { facets: { 'visual.axes/v0': { axes: [...axes] } } },
    })

  /**
   * The workspace's tag LIBRARY as `wb_facet_list` answers it: an array of
   * keys, each with its values and the colour a thing carrying one is drawn
   * in (ADR-0040 decision 5). Absent by default, because most boards declare
   * none and the verifier must work without one.
   */
  type Library = { key: string; values: { value: string; color: string }[] }[]
  const HEALTH_LIBRARY: Library = [
    {
      key: 'health',
      values: [
        { value: 'healthy', color: '4' },
        { value: 'failing', color: '1' },
      ],
    },
  ]

  const wbOver = (content: string, tagLibrary?: Library) => ({
    call: async (name: string) => {
      if (name === 'wb_document_list') {
        return { documents: [{ path: 'boards/fleet', documentId: 'doc-1' }] }
      }
      if (name === 'wb_document_get') return { documents: [{ content }] }
      if (name === 'wb_canvas_snapshot') return JSON.parse(content)
      if (name === 'wb_facet_list') {
        return { facets: [], assets: [], ...(tagLibrary === undefined ? {} : { tagLibrary }) }
      }
      throw new Error(`the verifier called an unexpected tool: ${name}`)
    },
  })

  const verify = (content: string, tagLibrary?: Library) =>
    FLEET?.verify?.(wbOver(content, tagLibrary) as never, {} as never)

  it('passes a board whose colour carries a DECLARED axis and whose shape carries the stencil', async () => {
    await expect(verify(fleetContent(FLEET_BOXES, ['ops.status/v0']))).resolves.toMatchObject({
      ok: true,
    })
  })

  it('passes a board whose colour carries a SCOPED TAG key with NO axis declared', async () => {
    // The end-to-end proof that a tag key reaches the lane: same pixels as
    // the declared case, the health recorded as `health:<status>` on each
    // box, and `visual.axes/v0` absent. The case below is its negative
    // control — the same board with an invented facet key and no
    // declaration refuses — so the pair discriminates on exactly the thing
    // the key buys.
    await expect(verify(fleetContent(FLEET_BOXES, [], healthTag))).resolves.toMatchObject({
      ok: true,
    })
  })

  /**
   * The case the LANE actually produced, and the one this verifier was
   * scoring wrong. Round 20c: every trial tagged each box `health:<status>`
   * and declared a `visual.tags/v0` library giving each value a colour, and
   * wrote no colour on any box — which is the whole point of declaring a
   * library. The boards rendered green and red; the verifier read
   * `colour unused` and failed two of three.
   *
   * The cause was not the instrument. `layoutSpatialCanvas` resolves a
   * declared colour onto the node (`withDeclaredColours`) BEFORE it lays
   * anything out, so `scoreFacets` and the legend both see it; the verifier
   * scored the raw stored document instead, which is a canvas nobody draws.
   *
   * The negative control is the case below it: the same board with no
   * library is `colour unused` for real, because nothing anywhere says what
   * an undeclared tag should be drawn in.
   */
  it('passes a board whose colour comes from the workspace tag LIBRARY, not from the boxes', async () => {
    const boxes = FLEET_BOXES.map(({ color: _dropped, ...rest }) => rest)
    await expect(verify(fleetContent(boxes, [], healthTag), HEALTH_LIBRARY)).resolves.toMatchObject(
      {
        ok: true,
      },
    )
  })

  it('refuses that same board when the workspace declares no library', async () => {
    // Nothing is drawn in anything: the tags are recorded and the boxes are
    // all one colour, so a reader sees one axis, not two. The pair above and
    // here is what discriminates "the verifier cannot see a declared colour"
    // from "there is no declared colour".
    const boxes = FLEET_BOXES.map(({ color: _dropped, ...rest }) => rest)
    await expect(verify(fleetContent(boxes, [], healthTag))).resolves.toMatchObject({ ok: false })
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

describe('the shared link helpers', () => {
  // `linked` / `linkedFrom` are how most write verifiers ask "is A connected
  // to B", and they have answered `false` for EVERY edge twice: first reading
  // a flat `fromNode` key, then testing a `kind` that ADR-0038 decision 2
  // retired. Each time every verifier built on them became impossible to
  // pass, and nothing anywhere went red.
  //
  // Nothing could, because the lane's own check is one-sided: `--dry-run`
  // asserts that a write verifier FAILS on the unseeded fixture, which a
  // permanently broken verifier does too. Both breakages were found by
  // spending model quota and reading "not connected" beside `edge.add` calls
  // that reported zero tool errors. A POSITIVE case is the cheap thing that
  // tells those two apart, and it belongs on the shared helper rather than on
  // one task's verifier, because the helper is what every other verifier
  // depends on.
  //
  // Ends are built through `edgeEndSchema` for the reason the kinds fixture
  // is: it is `.strict()`, so a fixture carrying a key the schema retired
  // throws here instead of quietly standing in for a payload no tool sends.
  //
  // Both directions are mutation-checked, and the second says why this is not
  // covered by what was already here: restoring the retired `kind` test fails
  // four of these cases, and a `linked` that answers `true` for every pair
  // fails two — while the kinds task's own five cases pass it, because that
  // verifier only ever asks about edges the good board really has.
  const box = (id: string) => ({ id })
  const a = box('a')
  const b = box('b')
  const lonely = box('lonely')
  const board = { edges: [{ id: 'e0', from: at('a'), to: at('b') }] }

  it('says a pair the board really connects IS connected', () => {
    expect(linked(board, a, b)).toBe(true)
  })

  it('reads an edge either way round, since a relation is not a direction', () => {
    expect(linked(board, b, a)).toBe(true)
  })

  it('says a pair no edge touches is not connected', () => {
    // The other side of the guard: a helper that answered `true` for
    // everything would pass every case above and grade every board a pass.
    expect(linked(board, a, lonely)).toBe(false)
  })

  it('keeps direction where the caller asked for it', () => {
    expect(linkedFrom(board, a, b)).toBe(true)
    expect(linkedFrom(board, b, a)).toBe(false)
  })

  it('reads an end that also carries a side and an arrowhead', () => {
    // `side` and `end` are optional on the schema, and a model that names
    // either is drawing the same relation. A helper keyed on the end object's
    // exact shape rather than on its `node` would refuse these.
    const dressed = {
      edges: [
        {
          id: 'e0',
          from: edgeEndSchema.parse({ node: 'a', side: 'right' }),
          to: edgeEndSchema.parse({ node: 'b', side: 'left', end: 'arrow' }),
        },
      ],
    }
    expect(linked(dressed, a, b)).toBe(true)
    expect(linkedFrom(dressed, a, b)).toBe(true)
  })

  it('answers for an end the snapshot left out instead of throwing', () => {
    // A verifier reads whatever the tools answered. An end that is absent is
    // a board that does not connect anything, not a crash that reads as an
    // infrastructure failure.
    const ragged = { edges: [{ id: 'e0', from: undefined, to: at('b') }] }
    expect(endNode(undefined)).toBeUndefined()
    expect(linked(ragged, a, b)).toBe(false)
  })
})

// The one rule in the sequence-diagram verifier that has been got wrong
// before, and the reason it is stated in the source: a node reading
// "renders rows" contains BOTH "rows" and "render", so a substring search
// that let two steps share it grades the wrong geometry. The rest of that
// verifier stays uncovered by this file's standing rule — a case is earned,
// not written on principle.
describe('the sequence-diagram message claim', () => {
  const box = (id: string, text: string) => ({
    id,
    type: 'text',
    text,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  })

  it('gives each step its own node, closest match first', () => {
    const board = {
      nodes: [
        box('p1', 'Browser'),
        box('n1', 'renders rows'),
        box('n2', 'rows'),
        box('n3', 'render'),
      ],
    }

    const claimed = claimMessageNodes(board, [['rows'], ['render']], ['Browser'])

    expect(claimed.map((n: { id: string }) => n.id)).toEqual(['n2', 'n3'])
  })

  it('leaves a step unclaimed rather than reusing a node', () => {
    const board = { nodes: [box('n1', 'renders rows')] }

    const claimed = claimMessageNodes(board, [['rows'], ['render']], [])

    expect(claimed[0]?.id).toBe('n1')
    expect(claimed[1]).toBeUndefined()
  })

  it('never claims a participant box', () => {
    const board = { nodes: [box('p1', 'Daemon'), box('n1', 'Daemon ready')] }

    const claimed = claimMessageNodes(board, [['daemon']], ['Daemon'])

    expect(claimed[0]?.id).toBe('n1')
  })
})
