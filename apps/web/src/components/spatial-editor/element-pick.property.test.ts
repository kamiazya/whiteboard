// @vitest-environment node
/**
 * Every KIND of element a canvas holds, driven through every editor surface
 * that has to know about it — and a ledger that is TALLIED BY THIS RUN
 * rather than by citing files.
 *
 * Why it is a property and not a table. A whole session's defects arrived
 * the same way: `lines` were added to the model and the editor learned about
 * them one surface at a time, each gap found by a person using the product.
 * The press hit-test settled on the node under the stroke, the band looked
 * at boxes only, the menu resolved its target out of `canvas.edges`, and
 * shift dropped the selection it was meant to grow. Every one passed every
 * suite. The first answer written down was a table naming, per kind and per
 * surface, the test file that covered it — and a citation is not evidence:
 * it stays true while the surface it names stops running for the kind beside
 * it, which is the exact failure shape it was written against.
 *
 * So the surfaces are driven here, per kind, from generated boards, and each
 * cell of the ledger is `covered` only if the run PRODUCED it. Four
 * directions hold it, the standing contract of
 * `.claude/rules/coverage-ledger.md`: the type system refuses a new
 * collection (missing property) and a collection that left (excess), and
 * `assertLedger` refuses a `covered` the run never reached and a
 * `not modelled` it reached anyway.
 *
 * The fifth direction is the one a test cannot have, and it is why
 * `ELEMENT_PICK_ROLE` lives in `element-pick.ts` rather than here: adding a
 * collection to `SpatialCanvas` stops `tsc` on the EDITOR's own build, not
 * on a guard somebody can choose not to run.
 */
import type { CanvasEdge, CanvasLine, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterAll, describe, expect, it } from 'vitest'
import { applyCommand, deleteInkCommand } from '../../lib/spatial/commands.js'
import type { NodeBox } from '../../lib/spatial/geometry.js'
import type { Point } from '../../lib/spatial/viewport.js'
import { assertLedger, emptyTally, type SurfaceCoverage } from '../../test-utils/coverage-ledger.js'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import {
  bandProbes,
  CONTENT_PICK_ORDER,
  type ContentKind,
  ELEMENT_PICK_ROLE,
  type ElementCollection,
  type PickInputs,
  pickContentAt,
  pickContentWithin,
  pressProbes,
  shiftPress,
} from './element-pick.js'
import { type DrawnPath, withGroupMates } from './ink-hit.js'

/**
 * The surfaces an element kind has to be answered for. Each one is a place a
 * line was forgotten; the list is the shape of this session's bug report,
 * not a taxonomy invented in advance.
 */
type EditorSurface =
  | 'press'
  | 'shift-press'
  | 'marquee'
  | 'context menu'
  | 'delete'
  | 'lock'
  | 'selection highlight'

const SURFACES = [
  'press',
  'shift-press',
  'marquee',
  'context menu',
  'delete',
  'lock',
  'selection highlight',
] as const satisfies readonly EditorSurface[]

/**
 * The ledger. `covered` means a property below produced that cell; the run
 * checks it. `not modelled` carries its reason, and for the cells whose real
 * coverage is a browser test it NAMES that file — checked to exist, because
 * this table has already been caught citing a file that was not there.
 */
const ELEMENT_SURFACES = {
  nodes: {
    press: 'covered',
    'shift-press': 'covered',
    marquee: 'covered',
    'context menu':
      'not modelled: the menu is a component — which verbs it offers is JSX, not a decision this layer can produce. context-menu.browser.test.tsx drives the real one',
    delete: 'covered',
    lock: "not modelled: a node lock is applied by the CALLER, which hands `pressProbes` a box list that already excludes locked nodes — so a property here would be asserting its own filtering rather than the editor's. node-lock.browser.test.tsx drives the real filter, and this asymmetry with the path lock (which the probe applies itself) is worth knowing before a third kind picks one of the two",
    'selection highlight':
      'not modelled: the highlight is rendered geometry, so what it proves is pixels on a page. multi-select.browser.test.tsx reads the real overlay',
  },
  edges: {
    press: 'covered',
    'shift-press': 'covered',
    marquee: 'covered',
    'context menu':
      'not modelled: the same reason the node menu is — the builders are JSX. context-menu.browser.test.tsx drives the real one',
    delete: 'covered',
    lock: 'covered',
    'selection highlight':
      'not modelled: rendered geometry, as above. edge-select-delete.browser.test.tsx reads the real overlay',
  },
  lines: {
    press: 'covered',
    'shift-press': 'covered',
    marquee: 'covered',
    'context menu':
      'not modelled: the same reason as the other two — the builders are JSX. freehand-ink.browser.test.tsx drives the ink menu, which is the one that did not exist',
    delete: 'covered',
    lock: 'covered',
    'selection highlight':
      'not modelled: rendered geometry, as above. freehand-ink.browser.test.tsx reads the real overlay',
  },
  comments: {
    press:
      'not modelled: a comment is CHROME rather than content (`ELEMENT_PICK_ROLE`) — its pin takes the press before content is contended for, so it is not in this contention at all. comment-create.browser.test.tsx drives its press',
    'shift-press':
      'not modelled: a comment is not content (ADR-0024) — it is never part of a selection a verb acts on, so there is nothing for shift to add it to',
    marquee: 'not modelled: the same reason — a band gathers content, and a comment is not content',
    'context menu':
      'not modelled: a comment HAS its own menu, and it is JSX like the others. comment-edit.browser.test.tsx drives it',
    delete:
      'not modelled: a thread is RESOLVED rather than deleted, and the annotation layer is never tidied (see .claude/rules/vocabulary.md). Its verb is set-comment-resolved',
    lock: 'not modelled: the lock is about who may change the document; a comment is beside it',
    'selection highlight': 'not modelled: nothing selects a comment, so nothing highlights one',
  },
} satisfies Record<ElementCollection, Record<EditorSurface, SurfaceCoverage>>

/** Flattened for `assertLedger`, whose contract is one dimension. */
type Cell = `${ElementCollection}/${EditorSurface}`
const flatLedger = Object.fromEntries(
  Object.entries(ELEMENT_SURFACES).flatMap(([collection, surfaces]) =>
    Object.entries(surfaces).map(([surface, answer]) => [`${collection}/${surface}`, answer]),
  ),
) as Record<Cell, SurfaceCoverage>

const tally = emptyTally(flatLedger)
const produced = (collection: ElementCollection, surface: EditorSurface): void => {
  tally[`${collection}/${surface}` as Cell] += 1
}

/* ------------------------------------------------------------------ */
/* Generators: one element of one kind, plus a point ON it and a band  */
/* AROUND it. Each kind answers the same three questions, so a         */
/* property can be stated over the kind rather than over the geometry. */
/* ------------------------------------------------------------------ */

interface Placed {
  readonly kind: ContentKind
  readonly id: string
  readonly inputs: (locked: boolean) => PickInputs
  readonly on: Point
  readonly band: { x: number; y: number; w: number; h: number }
  /** The same element in a real canvas, for the delete surface. */
  readonly canvas: SpatialCanvas
}

const TOLERANCE = 6
const coord = fc.integer({ min: -400, max: 400 })

const pointArb = fc.record({ x: coord, y: coord })

const boxArb = fc.record({
  x: coord,
  y: coord,
  width: fc.integer({ min: 20, max: 200 }),
  height: fc.integer({ min: 20, max: 200 }),
})

/** A polyline with at least two distinct points, so it has length to press. */
const polylineArb = fc
  .tuple(
    pointArb,
    fc.array(
      fc.record({
        dx: fc.integer({ min: -200, max: 200 }),
        dy: fc.integer({ min: -200, max: 200 }),
      }),
      { minLength: 1, maxLength: 4 },
    ),
  )
  .map(([start, steps]) => {
    const path: Point[] = [start]
    for (const step of steps) {
      const last = path[path.length - 1] as Point
      // Never a zero step: a degenerate polyline has no interior to press and
      // would make "a point on it" mean the endpoint every time.
      path.push({
        x: last.x + (step.dx === 0 ? 7 : step.dx),
        y: last.y + (step.dy === 0 ? 7 : step.dy),
      })
    }
    return path as readonly Point[]
  })

const bandAround = (points: readonly Point[]) => {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = Math.min(...xs) - 10
  const y = Math.min(...ys) - 10
  return { x, y, w: Math.max(...xs) - x + 10, h: Math.max(...ys) - y + 10 }
}

const emptyInputs = { paths: [], boxes: [], tolerance: TOLERANCE, isEdgeLocked: () => false }

const lineOf = (id: string, path: readonly Point[]): CanvasLine => ({
  id,
  from: { kind: 'point', point: { x: path[0]?.x ?? 0, y: path[0]?.y ?? 0 } },
  to: {
    kind: 'point',
    point: { x: path[path.length - 1]?.x ?? 0, y: path[path.length - 1]?.y ?? 0 },
  },
  ...(path.length > 2 ? { bends: path.slice(1, -1).map((p) => ({ x: p.x, y: p.y })) } : {}),
})

// An edge's end names a node and nothing else — ADR-0038 decision 2 took the
// discriminator off it, which is the whole difference from a line's end.
const edgeOf = (id: string): CanvasEdge => ({
  id,
  from: { node: 'n-from' },
  to: { node: 'n-to' },
})

const placedNode = boxArb.map(
  (box): Placed => ({
    kind: 'nodes',
    id: 'the-node',
    inputs: (locked) => ({
      ...emptyInputs,
      // A locked node never reaches the probes: the caller drops it from the
      // box list (`selectableBoxes`). That is the asymmetry the ledger's
      // nodes/lock cell records.
      boxes: locked ? [] : ([{ id: 'the-node', box }] satisfies readonly NodeBox[]),
    }),
    on: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    band: { x: box.x - 5, y: box.y - 5, w: box.width + 10, h: box.height + 10 },
    canvas: {
      nodes: [
        textNode({
          id: 'the-node',
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          text: 'n',
        }),
      ],
      edges: [],
    },
  }),
)

const placedPath = (kind: 'lines' | 'edges') =>
  polylineArb.map((path): Placed => {
    const id = kind === 'lines' ? 'the-line' : 'the-edge'
    const drawn: DrawnPath = kind === 'lines' ? { id, path, ink: true } : { id, path }
    return {
      kind,
      id,
      inputs: (locked) => ({
        ...emptyInputs,
        paths: [drawn],
        isEdgeLocked: (probed) => locked && probed === id,
      }),
      on: path[0] as Point,
      band: bandAround(path),
      canvas: {
        nodes: [
          textNode({ id: 'n-from', x: -900, y: -900, width: 10, height: 10, text: 'a' }),
          textNode({ id: 'n-to', x: 900, y: 900, width: 10, height: 10, text: 'b' }),
        ],
        edges: kind === 'edges' ? [edgeOf(id)] : [],
        ...(kind === 'lines' ? { lines: [lineOf(id, path)] } : {}),
      },
    }
  })

/** One arbitrary per content kind, so every property below is stated over the KIND. */
const PLACED: Record<ContentKind, fc.Arbitrary<Placed>> = {
  nodes: placedNode,
  lines: placedPath('lines'),
  edges: placedPath('edges'),
}

/**
 * Drawn from `PLACED`'s own keys, which the type ties to the ROLE table —
 * never from `CONTENT_PICK_ORDER`.
 *
 * It was the order at first, and that made the generator an oracle built out
 * of the code it judges: removing a kind from the order removed it from the
 * draws, so the two properties that exist to catch exactly that removal
 * never saw the kind and passed. Measured — the mutation was caught only by
 * the bridge test below, which is one rung and not three.
 */
const placedArb = fc.oneof(...Object.values(PLACED))

describe('every element kind, through every surface that has to know about it', () => {
  fcTest.prop([placedArb], withDefaults())(
    'a press on an element of any content kind answers that element',
    (placed) => {
      const pick = pickContentAt(pressProbes(placed.inputs(false)), placed.on)
      expect(pick).toEqual({ kind: placed.kind, id: placed.id })
      produced(placed.kind, 'press')
    },
  )

  fcTest.prop([placedArb, pointArb], withDefaults())(
    'a press answers nothing only when every probe does — so a kind dropped from the order fails here',
    (placed, at) => {
      // The ORDERED scan against the UNORDERED set of probes. Stated this way
      // rather than "the first probe that answers wins", which would be the
      // implementation read back: a kind present in the record and missing
      // from `CONTENT_PICK_ORDER` passes that one and fails this.
      const probes = pressProbes(placed.inputs(false))
      const anyAnswers = Object.values(probes).some(
        (probe) => typeof probe === 'function' && probe(at) !== undefined,
      )
      expect(pickContentAt(probes, at) === undefined).toBe(!anyAnswers)
    },
  )

  fcTest.prop([placedArb], withDefaults())(
    'a band gathers every kind it is declared to take, and the kinds it skips say why',
    (placed) => {
      const probes = bandProbes(placed.inputs(false))
      const gathered = pickContentWithin(probes, placed.band)
      const probe = probes[placed.kind]
      if (typeof probe === 'function') {
        expect(gathered[placed.kind]).toContain(placed.id)
      } else {
        // A kind the band skips answers nothing AND owes a sentence — a
        // reason under a clause is the omission with a word in front of it.
        expect(gathered[placed.kind]).toEqual([])
        expect(probe.skipped.length).toBeGreaterThan(40)
      }
      produced(placed.kind, 'marquee')
    },
  )

  fcTest.prop(
    [placedArb, fc.array(fc.constantFrom('the-line', 'the-edge', 'the-node'), { maxLength: 3 })],
    withDefaults(),
  )(
    'shift answers for every kind — a toggle, the next mark, or a reason it does nothing',
    (placed, held) => {
      const pick = pickContentAt(pressProbes(placed.inputs(false)), placed.on)
      const shift = shiftPress(pick, held, placed.canvas.lines, withGroupMates)
      switch (shift.kind) {
        case 'nodes':
          expect(shift.id).toBe(placed.id)
          break
        case 'lines':
          // Shift GROWS or SHRINKS, never replaces: every id it answers was
          // either held already or is the mark just pressed. This is the
          // statement the two shipped defects would have failed — one
          // replaced the held ink, the other dropped it entirely.
          for (const id of shift.ids) expect([...held, placed.id]).toContain(id)
          break
        default:
          expect(shift.because.length).toBeGreaterThan(40)
      }
      produced(placed.kind, 'shift-press')
    },
  )

  fcTest.prop([placedArb], withDefaults())(
    'a locked element is never picked, whatever its kind',
    (placed) => {
      expect(pickContentAt(pressProbes(placed.inputs(true)), placed.on)).toBeUndefined()
      // Only the kinds whose probe applies the lock ITSELF are claimed; the
      // node lock is the caller's and the ledger says so.
      if (placed.kind !== 'nodes') produced(placed.kind, 'lock')
    },
  )

  fcTest.prop([placedArb], withDefaults())(
    'delete removes the picked element whatever its kind, through the one command that looks',
    (placed) => {
      const pick = pickContentAt(pressProbes(placed.inputs(false)), placed.on)
      expect(pick?.id).toBe(placed.id)
      // `deleteInkCommand` is the one place that decides whether an id names
      // an edge or a line; a node's verb is its own. Both go through
      // `applyCommand`, which is what the editor's Delete does.
      const command =
        placed.kind === 'nodes'
          ? ({ kind: 'delete-node', id: placed.id } as const)
          : deleteInkCommand(placed.canvas, placed.id)
      expect(command).toBeDefined()
      const next = applyCommand(placed.canvas, command as NonNullable<typeof command>)
      const remaining = [
        ...next.nodes.map((n) => n.id),
        ...next.edges.map((e) => e.id),
        ...(next.lines ?? []).map((l) => l.id),
      ]
      expect(remaining).not.toContain(placed.id)
      produced(placed.kind, 'delete')
    },
  )

  it('asks the question of every pair', () => {
    // 4 collections x 7 surfaces. A vacuous table is the failure mode a
    // ledger has, so the count is asserted rather than assumed.
    expect(Object.keys(flatLedger)).toHaveLength(28)
  })

  it('drives every kind the role table calls content, and no kind it does not', () => {
    // The bridge between the two halves. `ELEMENT_PICK_ROLE` is what stops
    // `tsc` when a collection is added; this is what stops a kind being
    // DECLARED content and never reached — the failure a type cannot see.
    const contended = Object.entries(ELEMENT_PICK_ROLE)
      .filter(([, role]) => role === 'content')
      .map(([kind]) => kind)
    expect([...CONTENT_PICK_ORDER].sort()).toEqual(contended.sort())
    expect(Object.keys(PLACED).sort()).toEqual(contended.sort())
  })

  it('gives every unmodelled cell a reason worth reading', () => {
    const thin = Object.entries(flatLedger)
      .filter(([, answer]) => answer !== 'covered')
      .filter(([, answer]) => answer.split(': ').slice(1).join(': ').length < 40)
      .map(([cell]) => cell)
    expect(thin).toEqual([])
  })

  it('names a browser test that exists wherever a reason cites one', () => {
    // The half the first version of this table had and nothing else: a
    // citation that names no file was never checked by anything. It caught a
    // fabricated one the first time it ran.
    const known = new Set(
      [
        ...Object.keys(import.meta.glob('./**/*.test.{ts,tsx}')),
        ...Object.keys(import.meta.glob('../**/*.test.{ts,tsx}')),
      ].map((path) => path.slice(path.lastIndexOf('/') + 1)),
    )
    const missing = Object.entries(flatLedger)
      .flatMap(([cell, answer]) =>
        [...answer.matchAll(/[\w.-]+\.browser\.test\.tsx/g)].map((m) => ({ cell, file: m[0] })),
      )
      .filter(({ file }) => !known.has(file))
      .map(({ cell, file }) => `${cell} cites ${file}, which is not there`)
    expect(missing).toEqual([])
  })

  it('covers every surface name the ledger is keyed on', () => {
    expect([...SURFACES].sort()).toEqual(
      Object.keys(ELEMENT_SURFACES.nodes).sort() as unknown as EditorSurface[],
    )
  })

  afterAll(() => {
    assertLedger('element kind x surface', flatLedger, tally)
  })
})
