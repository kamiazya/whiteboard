import { type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { expect, test } from 'vitest'
import { layoutSpatialEdgesPicture } from '../../core-picture.js'
import type { EdgeAnchorOverride } from '../../edge-routing.js'
import { layoutSpatialCanvasWithAnchors, layoutSpatialEdges } from '../../layout/spatial-canvas.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { createFakeMeasure } from '../fake-measure.js'
import { built, requireWasm, wasmBytes } from './glue.js'

/**
 * The drag overlay's frame (ADR-0054 A3): the edge layer the editor lays out
 * on every pointer move (`use-drag-layers.ts`'s `liveEdges`) and the SVG it
 * draws that layer as, in the envelope the overlay spells (`{width, height,
 * viewBox}` over the layer's own bounds). The board is apps/web's `working
 * board (30 notes)`, the web board with the most edges, its busiest node
 * carried 4 px further each frame; bystanders are pinned at their committed
 * anchors and the carried edges either re-sided or held at their cached sides,
 * as `drag-frame-budget.browser.test.ts`'s overlay case composes one.
 *
 * Rows: the layer alone, and the layer with the core's own SVG of it in the
 * same call (`layoutSpatialEdgesPicture`, ADR-0054 A3.1), its decode of the
 * bigger answer included. The SVG's share is a difference of rows.
 *
 * Run with `pnpm bench`, after `pnpm rust:build:wasm:oracle`; without the
 * artifact the case is skipped. `vitest run` never collects a bench file.
 */
function working(dx: number, moved: string): SpatialCanvas {
  const nodes: SpatialNode[] = []
  const edges: CanvasEdge[] = []
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 6; col += 1) {
      const id = `w${row}-${col}`
      const text = `**Step ${row * 6 + col + 1}**\n\nCheck the *${col % 2 === 0 ? 'input' : 'output'}* of stage ${row} before moving on.`
      const x = col * 300 + (id === moved ? dx : 0)
      nodes.push(textNode({ id, x, y: row * 220, width: 220, height: 140, text }))
      const edge = (eid: string, from: string, label?: string): CanvasEdge => ({
        id: eid,
        from: { node: from },
        to: { node: id, end: 'arrow' },
        ...(label === undefined ? {} : { label }),
      })
      if (col > 0) edges.push(edge(`h${row}-${col}`, `w${row}-${col - 1}`))
      if (row > 0) edges.push(edge(`v${row}-${col}`, `w${row - 1}-${col}`, 'then'))
    }
  }
  return { nodes, edges } as SpatialCanvas
}

const MOVED = 'w2-2'
const measure = createFakeMeasure()
const appearance = createSpatialTheme({ mode: 'light' })

test.runIf(built)(
  'the drag overlay frame: its edge layer, and the SVG it is drawn as',
  {
    timeout: 0,
  },
  async ({ bench }) => {
    const real = coreFrom(requireWasm() as unknown as CoreGlue, wasmBytes())
    const core = { routing: real, layout: real, markdown: real, query: real }
    const base = { measure, appearance, style: 'document' as const, core }
    const { scene, anchors } = layoutSpatialCanvasWithAnchors(working(0, MOVED), base)
    const carried = new Set(
      working(0, MOVED)
        .edges.filter((e) => e.from.node === MOVED || e.to.node === MOVED)
        .map((e) => e.id),
    )
    const overridesFor = (cached: boolean) => {
      const overrides = new Map<string, EdgeAnchorOverride>()
      for (const node of scene.nodes) {
        if (node.kind !== 'edge') continue
        const sides = { fromSide: node.fromSide, toSide: node.toSide }
        if (carried.has(node.id)) {
          if (cached) overrides.set(node.id, sides)
          continue
        }
        overrides.set(node.id, { ...sides, ...anchors.get(node.id) })
      }
      return overrides
    }
    let frame = 0
    const lay = (overrides: Map<string, EdgeAnchorOverride>) =>
      layoutSpatialEdges(working((frame++ % 40) * 4, MOVED), {
        ...base,
        edgeSideOverrides: overrides,
      })

    const pictured = (overrides: Map<string, EdgeAnchorOverride>) =>
      layoutSpatialEdgesPicture(
        working((frame++ % 40) * 4, MOVED),
        { ...base, edgeSideOverrides: overrides },
        { viewBox: { of: 'scene' } },
      )

    // Judged before timed: every frame lays an edge layer out, and the core
    // draws it in the same call.
    for (const cached of [false, true]) {
      frame = 7
      const nodes = lay(overridesFor(cached))
      expect(nodes.length).toBeGreaterThan(40)
      frame = 7
      const picture = pictured(overridesFor(cached))
      expect(picture.nodes).toEqual(nodes)
      expect(picture.svg.startsWith('<svg ')).toBe(true)
    }

    for (const cached of [true, false]) {
      const overrides = overridesFor(cached)
      const mode = cached ? 'cached sides' : 're-siding'
      await bench.compare(
        bench(`${mode}: core edge layer alone`, () => lay(overrides)),
        bench(`${mode}: core edge layer + core SVG`, () => pictured(overrides).svg),
      )
    }
  },
)
