/**
 * The walk remembers what it read of each body and stops reading a body once
 * it holds as much of it as any walk can use. Both are pure speed: the answer
 * must be what reading every body in full, every time, would have given.
 *
 * The oracle below is that reading — the whole match list from
 * `scanReferences`, filtered and budgeted inline, with nothing remembered —
 * so it shares the grammar with the walk and none of the bookkeeping under
 * test. The generator draws from one pool of names, so what a loaded body
 * names overlaps what the walk already holds, which is the case the scan's
 * stopping rule is argued for.
 */
import { scanReferences } from '@kamiazya/whiteboard-codec'
import { newImageRef, type SpatialCanvas, storedImageRefs } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { fc } from '../test-utils/fast-check.js'
import type { LoadedReference, ReferenceGraph } from './loaded-reference.js'
import { imageTargets, REFERENCE_BUDGET, referenceTargets } from './targets.js'

const POOL = 3 * REFERENCE_BUDGET
const nameAt = (i: number) => (i % 17 === 0 ? newImageRef(`p${i}`) : `n${i}`)

/** The walk as first written: every body read in full, every call. */
function oracleTargets(
  seeds: { bodies: readonly string[]; canvases: readonly SpatialCanvas[] },
  loaded: ReferenceGraph,
): string[] {
  const targets = new Set<string>()
  const queue: { target: string; depth: number }[] = []
  const add = (target: string, depth: number) => {
    if (target.startsWith(newImageRef(''))) return
    if (targets.size >= REFERENCE_BUDGET || targets.has(target)) return
    targets.add(target)
    queue.push({ target, depth })
  }
  const addBody = (body: string, depth: number) => {
    for (const match of scanReferences(body)) add(match.target, depth)
  }
  const addCanvas = (canvas: SpatialCanvas, depth: number) => {
    for (const node of canvas.nodes) {
      if (node.resource?.location !== undefined) add(node.resource.location, depth)
      else if (node.resource?.content !== undefined) addBody(node.resource.content, depth)
    }
  }
  for (const body of seeds.bodies) addBody(body, 1)
  for (const canvas of seeds.canvases) addCanvas(canvas, 1)
  for (let i = 0; i < queue.length; i += 1) {
    const { target, depth } = queue[i] as { target: string; depth: number }
    if (depth >= 3) continue
    const entry = loaded.get(target)
    if (entry === undefined || entry === null) continue
    if (entry.body !== undefined) addBody(entry.body, depth + 1)
    else if (entry.canvas !== undefined) addCanvas(entry.canvas, depth + 1)
  }
  return [...targets]
}

function oracleImages(
  seeds: { bodies: readonly string[]; canvases: readonly SpatialCanvas[] },
  loaded: ReferenceGraph,
): string[] {
  const images = new Set<string>()
  const addAll = (refs: readonly string[]) => {
    for (const ref of refs) if (images.size < REFERENCE_BUDGET) images.add(ref)
  }
  for (const body of seeds.bodies) addAll(storedImageRefs({ body }))
  for (const canvas of seeds.canvases) addAll(storedImageRefs({ canvas }))
  for (const target of oracleTargets(seeds, loaded)) {
    const entry = loaded.get(target)
    if (entry === undefined || entry === null) continue
    if (entry.body !== undefined) addAll(storedImageRefs({ body: entry.body }))
    else if (entry.canvas !== undefined) addAll(storedImageRefs({ canvas: entry.canvas }))
  }
  return [...images]
}

/** A run of the pool, which is what makes two bodies overlap. */
const slice = fc
  .tuple(fc.nat({ max: POOL - 1 }), fc.nat({ max: 2 * REFERENCE_BUDGET + 120 }))
  .map(([start, length]) =>
    Array.from({ length }, (_, i) => nameAt((start + i) % POOL))
      .map((name, i) => (i % 5 === 0 ? `![](${name})` : `[[${name}]]`))
      .join(' '),
  )

const record = fc.oneof(
  { weight: 5, arbitrary: slice.map((body): LoadedReference => ({ body })) },
  {
    weight: 1,
    arbitrary: fc.tuple(slice, fc.nat({ max: POOL - 1 })).map(
      ([text, file]): LoadedReference => ({
        canvas: {
          nodes: [
            textNode({ id: 't', x: 0, y: 0, width: 1, height: 1, text }),
            fileNode({ id: 'f', x: 0, y: 0, width: 1, height: 1, file: nameAt(file) }),
          ],
          edges: [],
        },
      }),
    ),
  },
  { weight: 1, arbitrary: fc.constant(null) },
)

const scenario = fc.record({
  bodies: fc.array(slice, { maxLength: 2 }),
  canvasText: slice,
  loaded: fc.array(fc.tuple(fc.nat({ max: POOL - 1 }), record), { maxLength: 40 }),
  /** Which loaded records a second call sees, over the SAME record objects. */
  later: fc.array(fc.boolean(), { minLength: 40, maxLength: 40 }),
})

describe('the reference walk', () => {
  it('answers what reading every body in full would, on every call', () => {
    let spent = 0
    fc.assert(
      fc.property(scenario, ({ bodies, canvasText, loaded, later }) => {
        const canvases: SpatialCanvas[] = [
          {
            nodes: [textNode({ id: 'c', x: 0, y: 0, width: 1, height: 1, text: canvasText })],
            edges: [],
          },
        ]
        const seeds = { bodies, canvases }
        const graph = new Map(loaded.map(([i, entry]) => [nameAt(i), entry] as const))
        const fewer = new Map([...graph].filter((_, i) => later[i] === true))
        for (const each of [graph, fewer, graph]) {
          const walked = referenceTargets({ ...seeds, loaded: each })
          expect(walked).toEqual(oracleTargets(seeds, each))
          expect(imageTargets({ ...seeds, loaded: each })).toEqual(oracleImages(seeds, each))
          if (walked.length === REFERENCE_BUDGET) spent += 1
        }
      }),
      { numRuns: 60 },
    )
    // The budget is where the stopping rule decides anything; a generator that
    // never reached it would pass over the rule.
    expect(spent).toBeGreaterThan(30)
  })
})
