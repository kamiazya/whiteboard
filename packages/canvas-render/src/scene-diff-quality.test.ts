import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { layoutSpatialCanvas } from './layout/spatial-canvas.js'
import { sceneEntryKeys } from './scene-entry-keys.js'
import type { NodeOutlineKind, Scene } from './scene-graph.js'
import { createFakeMeasure } from './test-utils/fake-measure.js'
import { createSpatialTheme } from './theme/spatial-theme.js'

/**
 * The SCENE-DIFF SCOREBOARD: how much of a laid-out scene actually changes
 * under a typical single edit. This is the go/no-go number for keyed
 * per-group DOM patching in the editor (an incremental-rendering layer can
 * only reuse what layout left byte-identical), measured BEFORE building
 * that layer — the instrument-first rule.
 *
 * Every count is pinned EXACTLY, not as a ceiling, so an improvement in
 * layout stability (e.g. localized edge re-routing) is as loud as a
 * regression. `changed` counts top-level scene entries whose JSON differs
 * (or that appear/disappear) between the base layout and the layout of the
 * edited canvas; rendering is a pure per-entry function of these entries,
 * so a changed entry is exactly a changed emitted group.
 *
 * The corpus is one deterministic 40-node/54-edge grid document — the
 * scale an AI-authored canvas reaches — with wrapping text, a hub node,
 * and both grid-neighbour and long-range edges. Deterministic measurer
 * (fake, monospace-like) and theme, so the numbers cannot drift with
 * fonts or platforms.
 */

const COLS = 8
const NODE_COUNT = 40

function buildCanvas(): { canvas: SpatialCanvas; leafId: string; hubId: string } {
  const nodes: SpatialNode[] = []
  const edges: CanvasEdge[] = []
  for (let i = 0; i < NODE_COUNT; i++) {
    const col = i % COLS
    const row = Math.floor(i / COLS)
    nodes.push({
      id: `n${i}`,
      type: 'text',
      x: col * 320,
      y: row * 220,
      width: 240,
      height: 140,
      text: `# Step ${i}\n\nThis node explains stage ${i} of the pipeline with a sentence long enough to wrap across lines.`,
    })
  }
  for (let i = 0; i < NODE_COUNT; i++) {
    if (i + 1 < NODE_COUNT) edges.push({ id: `e${i}a`, fromNode: `n${i}`, toNode: `n${i + 1}` })
    if (i + COLS < NODE_COUNT && i % 2 === 0) {
      edges.push({ id: `e${i}b`, fromNode: `n${i}`, toNode: `n${i + COLS}` })
    }
  }
  // n0 is the hub every long-range edge below meets; n39 is the far corner
  // leaf (edge-degree 1) whose move should be the most local edit there is.
  for (const target of ['n13', 'n21', 'n34']) {
    edges.push({ id: `hub-${target}`, fromNode: 'n0', toNode: target })
  }
  return { canvas: { nodes, edges }, leafId: 'n39', hubId: 'n0' }
}

const layout = (canvas: SpatialCanvas): Scene =>
  layoutSpatialCanvas(canvas, {
    measure: createFakeMeasure(),
    appearance: createSpatialTheme({ mode: 'light' }),
  })

/** Entries keyed by the shared producer the keyed SVG renderer patches by
 * (scene-entry-keys.ts) — one keying, so this scoreboard's counts are
 * exactly the group replacements a patch layer would perform. */
function keyedEntries(scene: Scene): Map<string, string> {
  const keys = sceneEntryKeys(scene)
  return new Map(
    scene.nodes.map((node, index) => [keys[index] ?? `#${index}`, JSON.stringify(node)]),
  )
}

function diffCount(base: Scene, edited: Scene): { changed: number; total: number } {
  const before = keyedEntries(base)
  const after = keyedEntries(edited)
  let changed = 0
  for (const [key, value] of after) {
    if (before.get(key) !== value) changed += 1
  }
  for (const key of before.keys()) {
    if (!after.has(key)) changed += 1
  }
  return { changed, total: after.size }
}

function editNode(
  canvas: SpatialCanvas,
  id: string,
  patch: (node: SpatialNode) => SpatialNode,
): SpatialCanvas {
  return { ...canvas, nodes: canvas.nodes.map((n) => (n.id === id ? patch(n) : n)) }
}

describe('scene-diff scoreboard (single edit → fraction of the scene that changes)', () => {
  const { canvas, leafId, hubId } = buildCanvas()
  const base = layout(canvas)

  it('is measured against a stable corpus size', () => {
    // 40 shapes + ~2 content entries per node (heading, paragraph) + 57 edges.
    expect(keyedEntries(base).size).toBe(178)
  })

  it('moving the far-corner leaf node re-lays only its own neighbourhood', () => {
    const edited = layout(editNode(canvas, leafId, (n) => ({ ...n, x: (n.x ?? 0) + 10 })))
    expect(diffCount(base, edited)).toEqual({ changed: 11, total: 178 })
  })

  it('moving the hub node reaches the edges it anchors, and no further', () => {
    const edited = layout(editNode(canvas, hubId, (n) => ({ ...n, x: (n.x ?? 0) + 10 })))
    expect(diffCount(base, edited)).toEqual({ changed: 8, total: 178 })
  })

  it('editing visible text touches that node content and nothing else', () => {
    const edited = layout(
      editNode(canvas, 'n18', (n) =>
        n.type === 'text' ? { ...n, text: (n.text ?? '').replace('# Step 18', '# Step 18b') } : n,
      ),
    )
    expect(diffCount(base, edited)).toEqual({ changed: 1, total: 178 })
  })

  it('an edit entirely past the truncation cut changes nothing — free reuse', () => {
    // The corpus bodies overflow their 140px boxes, so appended text falls
    // in the region fitBlocksToHeight already cut. The honest count is 0:
    // an incremental renderer gets these edits for free, and a layout
    // change that makes truncation leak into visible entries shows up here.
    const edited = layout(
      editNode(canvas, 'n18', (n) =>
        n.type === 'text' ? { ...n, text: `${n.text} Appended past the cut.` } : n,
      ),
    )
    expect(diffCount(base, edited)).toEqual({ changed: 0, total: 178 })
  })

  it('adding a disconnected node adds its own entries and disturbs nothing', () => {
    const added: SpatialNode = {
      id: 'n-new',
      type: 'text',
      x: 9 * 320,
      y: 0,
      width: 240,
      height: 140,
      text: 'New note',
    }
    const edited = layout({ ...canvas, nodes: [...canvas.nodes, added] })
    expect(diffCount(base, edited)).toEqual({ changed: 2, total: 180 })
  })

  it('deleting one edge removes exactly its own entry — surviving routes are untouched', () => {
    const edited = layout({ ...canvas, edges: canvas.edges.filter((e) => e.id !== 'e10a') })
    expect(diffCount(base, edited)).toEqual({ changed: 1, total: 177 })
  })
})

describe('decorated-scene column (outline decorations vs group reuse)', () => {
  const layoutWith = (
    canvas: SpatialCanvas,
    nodeOutlines: Readonly<Record<string, NodeOutlineKind>>,
  ): Scene =>
    layoutSpatialCanvas(canvas, {
      measure: createFakeMeasure(),
      appearance: createSpatialTheme({ mode: 'light' }),
      nodeOutlines,
    })

  it('decorating two nodes with outlines touches exactly their two chrome groups', () => {
    // On this grid the neighbours are axis-aligned, so every edge anchor
    // sits at a side midpoint — a TANGENT point of both outlines — and the
    // rim pull-in moves nothing: decoration costs only the decorated
    // chrome. An off-axis anchor would add its edge's group to the count,
    // which is the number to re-pin if the corpus ever gains one.
    const { canvas } = buildCanvas()
    const decorated = layoutWith(canvas, { n5: 'ellipse', n12: 'hexagon' })
    expect(diffCount(layout(canvas), decorated)).toEqual({ changed: 2, total: 178 })
  })

  it("swapping one node's outline kind replaces exactly that node's chrome group", () => {
    const { canvas } = buildCanvas()
    const before = layoutWith(canvas, { n5: 'ellipse', n12: 'hexagon' })
    const after = layoutWith(canvas, { n5: 'diamond', n12: 'hexagon' })
    expect(diffCount(before, after)).toEqual({ changed: 1, total: 178 })
  })
})
