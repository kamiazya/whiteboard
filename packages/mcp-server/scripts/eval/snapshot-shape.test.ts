// Every field the lane's VERIFIERS read off a board must be a field the
// snapshot actually answers.
//
// The gap this closes. A write verifier reads the store through the real
// tools; when a shape it reads narrows, it answers `ok: false` for every
// board, and that is indistinguishable from a correct refusal. `--dry-run`
// asserts only the NEGATIVE direction — every write verifier must fail on the
// unseeded fixture — so a verifier that can never pass passes the dry run.
// Twice now that has been found by spending a real lane run: first `endNode`
// reading a flat `fromNode` key, then `endNode` testing an `end.kind` that
// ADR-0038 decision 2 removed. Six of six trials, and the failure line named
// the model.
//
// Why this shape of guard rather than a seeded dry run. The obvious
// counterpart is a satisfying board per task, asserted to pass with no model
// call — 17 hand-written fixtures, which `tasks.test.ts`'s own header argues
// against on principle. Measuring the drift surface first said that is not
// what it takes: across all 17 verifiers, the fields read off a snapshot are
// a short tail of names, every one of them declared by `canvasSnapshotSchema`,
// and the two that actually drifted are the only NESTED ones. A top-level
// rename surfaces elsewhere eventually; a nested shape change surfaces
// nowhere. So the guard watches names, not boards.
//
// It observes RUNTIME reads through a Proxy rather than scanning the source.
// A regex over `tasks.mjs` would depend on what each verifier happens to call
// its variables, and a new verifier naming them differently would slip past —
// which is the same "guard that cannot see its subject" failure that let both
// instances through.
import { canvasSnapshotSchema } from '@kamiazya/whiteboard-server-core'
import { describe, expect, it } from 'vitest'
import {
  byText,
  centreX,
  endNode,
  firstOverlap,
  linked,
  linkedFrom,
  strictlyInside,
  TASKS,
  text,
} from './tasks.mjs'

/** Reads observed across every probe board, as `node.x` / `edge.from.node`. */
const reads = new Set<string>()

const RECORDING_NOISE = ['then', 'toJSON', 'constructor', 'inspect']

const spy = (o: Record<string, unknown>, path: string): unknown =>
  new Proxy(o, {
    get(target, key) {
      if (typeof key !== 'string') return Reflect.get(target, key)
      if (!RECORDING_NOISE.includes(key)) reads.add(`${path}.${key}`)
      const value = Reflect.get(target, key)
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? spy(value as Record<string, unknown>, `${path}.${key}`)
        : value
    },
  })

// The union of the label vocabularies the verifiers look for. One board, not
// one per task: a verifier that cannot find its boxes returns early and
// records the reads it managed, which is a weaker observation but never a
// wrong one.
const LABELS = [
  'Shopper',
  'API Gateway',
  'Orders Service',
  'Payments Service',
  'Postgres',
  'Events Queue',
  'Stripe',
  'Build',
  'Test',
  'Tests pass?',
  'Deploy',
  'Done',
  'Browser',
  'Daemon',
  'SQLite',
  'open document',
  'load snapshot',
  'rows',
  'render',
  'CLI',
  'Web app',
  'MCP server',
  'Events lake',
  'Pipeline',
]

type Probe = { group: boolean; colour: string | undefined; locked: boolean }

const boardOf = (opts: Probe) => {
  const nodes: Record<string, unknown>[] = LABELS.map((label, i) => ({
    id: label.toLowerCase().replace(/\W/g, ''),
    type: 'text',
    text: label,
    x: (i % 5) * 300,
    y: Math.floor(i / 5) * 200,
    width: 200,
    height: 80,
    ...(opts.colour === undefined ? {} : { color: opts.colour }),
    ...(opts.locked ? { locked: true } : {}),
  }))
  if (opts.group) {
    nodes.push({
      id: 'grp',
      type: 'group',
      label: 'Pipeline',
      x: -50,
      y: -50,
      width: 2000,
      height: 1400,
      ...(opts.colour === undefined ? {} : { color: opts.colour }),
    })
  }
  const edges = nodes.slice(0, -1).map((node, i) => ({
    id: `e${i}`,
    from: { node: node.id as string },
    to: { node: nodes[i + 1]?.id as string },
    label: 'yes',
    ...(opts.colour === undefined ? {} : { color: opts.colour }),
  }))
  return {
    nodes: nodes.map((n) => spy(n, 'node')),
    edges: edges.map((e) => spy(e, 'edge')),
    lines: [],
  }
}

// Three shapes rather than one, because coverage per board is NOT monotonic:
// widening one board made a verifier bail earlier and dropped a read the
// narrow board had reached. The union is what is stable.
const PROBES: readonly Probe[] = [
  { group: false, colour: undefined, locked: false },
  { group: true, colour: '5', locked: true },
  { group: true, colour: undefined, locked: false },
]

const WRITE_TASKS = TASKS.filter((t: { verify?: unknown }) => t.verify !== undefined)

const wbOver = (board: unknown) => ({
  call: async (name: string) => {
    if (name === 'wb_document_list') {
      return {
        documents: TASKS.filter((t: { boards?: string[] }) => t.boards !== undefined).flatMap(
          (t: { boards?: string[] }) => (t.boards ?? []).map((path) => ({ path, documentId: 'd' })),
        ),
      }
    }
    if (name === 'wb_canvas_snapshot') return board
    if (name === 'wb_document_get') {
      return { documents: [{ content: JSON.stringify({ nodes: [], edges: [] }) }] }
    }
    return {}
  },
})

/**
 * The shared helpers, driven DIRECTLY with proxied boards.
 *
 * Running the verifiers is not enough on its own, and a mutation proved it
 * rather than an argument: renaming the field `boxesOverlap` reads
 * (`width` -> `w`) survived a probe-board-only version of this guard, because
 * every verifier calls `firstOverlap` LAST — after its boxes and its flows
 * check out — and no generic board gets that far. The `node.x`/`node.width`
 * reads that made it look covered came from `centreX`.
 *
 * Driving each helper by hand reaches every field it reads regardless of how
 * deep a board takes a verifier, and it needs no satisfying fixture to do it.
 */
const driveHelpers = (board: { nodes: unknown[]; edges: unknown[] }) => {
  const [a, b] = board.nodes as Record<string, unknown>[]
  const edge = board.edges[0] as { from: unknown; to: unknown }
  if (a === undefined || b === undefined || edge === undefined) return
  const ids = { id: a.id as string }
  text(a)
  byText(board, 'Build')
  strictlyInside(a, b)
  firstOverlap(board.nodes)
  centreX(a)
  endNode(edge.from)
  endNode(edge.to)
  linked(board, ids, { id: b.id as string })
  linkedFrom(board, ids, { id: b.id as string })
}

let runs = 0
for (const probe of PROBES) {
  const board = boardOf(probe)
  driveHelpers(board)
  for (const task of WRITE_TASKS) {
    // A verifier may throw on a board it cannot make sense of. What it read
    // before throwing is still a read, and is still the subject here.
    try {
      await (task as { verify: (wb: unknown, ids: unknown) => Promise<unknown> }).verify(
        wbOver(board),
        {},
      )
    } catch {
      /* records whatever it reached */
    }
    runs += 1
  }
}

/** The keys a Zod object declares, via the schema rather than a second list. */
const keysOf = (schema: unknown): string[] =>
  Object.keys((schema as { shape: Record<string, unknown> }).shape)

const snapshot = canvasSnapshotSchema as unknown as { shape: Record<string, { element: unknown }> }
const NODE_KEYS = keysOf(snapshot.shape.nodes.element)
const EDGE_KEYS = keysOf(snapshot.shape.edges.element)
const EDGE_END_KEYS = keysOf(
  (snapshot.shape.edges.element as { shape: Record<string, unknown> }).shape.from,
)

const readsUnder = (prefix: string) =>
  [...reads].filter((r) => r.startsWith(`${prefix}.`)).map((r) => r.slice(prefix.length + 1))

describe('what the lane verifiers read off a board', () => {
  it('reached every verifier, so the observation is not vacuous', () => {
    // The count that proves the subject is present. A guard built on observed
    // reads says nothing at all if nothing was observed, and it would still
    // be green.
    expect(WRITE_TASKS.length).toBeGreaterThanOrEqual(17)
    expect(runs).toBe(WRITE_TASKS.length * PROBES.length)
    expect(reads.size).toBeGreaterThanOrEqual(12)
  })

  it('reaches the NESTED edge ends, which are the fields that actually drifted', () => {
    // Pinned by name because they are the whole reason this file exists: both
    // recorded instances of the gap were an edge end read the wrong way. If a
    // future probe board stops driving a verifier this deep, the guard has
    // quietly stopped watching the one thing it was built for.
    expect([...reads]).toEqual(expect.arrayContaining(['edge.from.node', 'edge.to.node']))
  })

  // WHERE THIS STOPS, said rather than implied. The guard checks the fields
  // that are READ, so a field no verifier and no helper touches is not
  // watched — today `color` and an edge's `label`, both of which only a
  // verifier driven by a satisfying board would reach. That is a smaller gap
  // than it sounds: an unread field cannot be read wrongly. What it does mean
  // is that a NEW verifier reading a field none of these probes drives is
  // outside this net until something drives it, which is why the helpers are
  // exercised by hand above rather than left to the boards.
  it('reads no node field the snapshot does not answer', () => {
    expect(readsUnder('node').filter((f) => !NODE_KEYS.includes(f))).toEqual([])
  })

  it('reads no edge field the snapshot does not answer', () => {
    const direct = readsUnder('edge').filter((f) => !f.includes('.'))
    expect(direct.filter((f) => !EDGE_KEYS.includes(f))).toEqual([])
  })

  it('reads no edge END field the snapshot does not answer', () => {
    // Where ADR-0038 decision 2 landed: an edge end is `{ node, side?, end? }`
    // and carries no `kind`, because an edge is a relation and cannot end in
    // empty space. Ink that can is a line, whose ends keep the union.
    const ends = [...reads]
      .filter((r) => r.startsWith('edge.from.') || r.startsWith('edge.to.'))
      .map((r) => r.split('.')[2] as string)
    expect([...new Set(ends)].filter((f) => !EDGE_END_KEYS.includes(f))).toEqual([])
  })
})
