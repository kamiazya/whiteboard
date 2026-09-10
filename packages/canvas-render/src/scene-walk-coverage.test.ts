/**
 * Three walkers move or measure a scene — `translateScene`, `scaleScene`,
 * `sceneBounds` — and each carries its own switch over the node kinds that
 * hold children. A kind missing from ONE of them is silent: the node lands
 * where it should and the things inside it do not.
 *
 * That is not hypothetical. `codeBlock` gained `runs` after all three were
 * written, was added to none of them, and shipped a fenced block whose panel
 * followed its node while the code stayed at the body's own origin — an
 * empty grey slab on every canvas, with `scaleScene`'s `default` branch
 * still commenting that a code block is "bbox-only".
 *
 * So the fixture below is exhaustive BY TYPE (`satisfies Record<...>`): a
 * kind added to the scene graph has to be classified here before this file
 * compiles, and a kind that says it holds children is driven through all
 * three walkers. `childrenAnywhere` reads every child field the scene graph
 * has rather than asking a walker which one applies — an oracle built out of
 * the switches under test would share their blind spot.
 */
import { expect, it } from 'vitest'
import { scaleScene } from './layout/scale-scene.js'
import { translateScene } from './layout/translate-scene.js'
import { sceneBounds } from './scene-bounds.js'
import type {
  ListItemNode,
  Scene,
  SceneNode,
  TableCellSceneNode,
  TableRowSceneNode,
  TextRunNode,
} from './scene-graph.js'

type WalkableNode = SceneNode | ListItemNode | TableRowSceneNode | TableCellSceneNode

/** Every field any scene node keeps children in. */
const CHILD_FIELDS = ['runs', 'children', 'items', 'rows', 'cells'] as const

function childrenAnywhere(node: WalkableNode): readonly WalkableNode[] {
  const record = node as unknown as Record<string, unknown>
  return CHILD_FIELDS.flatMap((field) =>
    Array.isArray(record[field]) ? (record[field] as readonly WalkableNode[]) : [],
  )
}

/** The marker leaves, wherever they are nested. */
function leaves(nodes: readonly WalkableNode[]): readonly TextRunNode[] {
  return nodes.flatMap((node) =>
    node.kind === 'textRun' ? [node] : leaves(childrenAnywhere(node)),
  )
}

/**
 * A marker run, placed well below and to the right of everything above it so
 * a walk that never reaches it is visible in `sceneBounds` as well as in the
 * two transforms.
 */
function marker(): TextRunNode {
  return { kind: 'textRun', bbox: { x: 500, y: 900, w: 10, h: 10 }, text: 'x' }
}

const BOX = { x: 0, y: 0, w: 100, h: 20 }

function cell(): TableCellSceneNode {
  return { kind: 'tableCell', bbox: BOX, runs: [marker()] }
}
function row(): TableRowSceneNode {
  return { kind: 'tableRow', bbox: BOX, cells: [cell()] }
}
function item(): ListItemNode {
  return { kind: 'listItem', bbox: BOX, children: [marker()] }
}

/**
 * One top-level node per kind. A kind that holds children carries exactly
 * one `marker()` leaf; a leaf kind carries none, and says so with `0`.
 *
 * The three wrapper kinds are not members of `SceneNode`, so each is given
 * through the node that owns it — which is the only way they ever reach a
 * walker anyway.
 */
const SAMPLES = {
  heading: { node: { kind: 'heading', bbox: BOX, level: 1, runs: [marker()] }, markers: 1 },
  paragraph: { node: { kind: 'paragraph', bbox: BOX, runs: [marker()] }, markers: 1 },
  codeBlock: { node: { kind: 'codeBlock', bbox: BOX, value: 'x', runs: [marker()] }, markers: 1 },
  blockquote: { node: { kind: 'blockquote', bbox: BOX, children: [marker()] }, markers: 1 },
  group: { node: { kind: 'group', bbox: BOX, children: [marker()] }, markers: 1 },
  embedResolved: {
    node: { kind: 'embedResolved', bbox: BOX, documentId: 'd', children: [marker()] },
    markers: 1,
  },
  list: {
    node: { kind: 'list', bbox: BOX, ordered: false, depth: 0, items: [item()] },
    markers: 1,
  },
  listItem: {
    node: { kind: 'list', bbox: BOX, ordered: false, depth: 0, items: [item()] },
    markers: 1,
  },
  table: { node: { kind: 'table', bbox: BOX, rows: [row()] }, markers: 1 },
  tableRow: { node: { kind: 'table', bbox: BOX, rows: [row()] }, markers: 1 },
  tableCell: { node: { kind: 'table', bbox: BOX, rows: [row()] }, markers: 1 },
  textRun: { node: marker(), markers: 1 },
  thematicBreak: { node: { kind: 'thematicBreak', bbox: BOX }, markers: 0 },
  rawHtml: { node: { kind: 'rawHtml', bbox: BOX, value: '<b/>' }, markers: 0 },
  unresolvedReference: {
    node: { kind: 'unresolvedReference', bbox: BOX, identifier: 'r' },
    markers: 0,
  },
  svgFragment: { node: { kind: 'svgFragment', bbox: BOX, svg: '<g/>' }, markers: 0 },
  embedPlaceholder: {
    node: { kind: 'embedPlaceholder', bbox: BOX, documentId: 'd', title: 't', reason: 'cycle' },
    markers: 0,
  },
  image: { node: { kind: 'image', bbox: BOX, href: 'about:blank' }, markers: 0 },
  icon: { node: { kind: 'icon', bbox: BOX, icon: 'x' }, markers: 0 },
  glyph: { node: { kind: 'glyph', bbox: BOX, glyph: 'x' }, markers: 0 },
  shape: { node: { kind: 'shape', bbox: BOX }, markers: 0 },
  edge: {
    node: {
      kind: 'edge',
      id: 'e',
      path: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      fromSide: 'right',
      toSide: 'left',
      fromEnd: 'none',
      toEnd: 'arrow',
    },
    markers: 0,
  },
} satisfies Record<WalkableNode['kind'], { node: SceneNode; markers: number }>

const CONTAINERS = Object.entries(SAMPLES).filter(([, sample]) => sample.markers > 0)

it('has a sample carrying the marker for every kind that holds children', () => {
  // The fixture is the subject of the three claims below, so a sample whose
  // marker never got nested would exempt its kind while reading as covered.
  for (const [kind, sample] of CONTAINERS) {
    expect(leaves([sample.node as WalkableNode]), kind).toHaveLength(sample.markers)
  }
  expect(CONTAINERS.length).toBe(12)
})

it('translateScene moves what every container holds', () => {
  for (const [kind, sample] of CONTAINERS) {
    const scene: Scene = { nodes: [sample.node as SceneNode] }
    const moved = leaves(translateScene(scene, 40, 70).nodes)
    // y only: x is deliberately left wrapper-relative under a listItem or a
    // tableCell (see translate-scene.ts), and y carries no such exception.
    expect(
      moved.map((run) => run.bbox.y),
      kind,
    ).toEqual([marker().bbox.y + 70])
  }
})

it('scaleScene scales what every container holds', () => {
  for (const [kind, sample] of CONTAINERS) {
    const scene: Scene = { nodes: [sample.node as SceneNode] }
    const scaled = leaves(scaleScene(scene, 0.5).nodes)
    expect(
      scaled.map((run) => run.bbox.y),
      kind,
    ).toEqual([marker().bbox.y * 0.5])
  }
})

it('sceneBounds measures what every container holds', () => {
  for (const [kind, sample] of CONTAINERS) {
    const bounds = sceneBounds({ nodes: [sample.node as SceneNode] })
    const bottom = marker().bbox.y + marker().bbox.h
    expect(bounds.y + bounds.h, kind).toBeGreaterThanOrEqual(bottom)
  }
})
