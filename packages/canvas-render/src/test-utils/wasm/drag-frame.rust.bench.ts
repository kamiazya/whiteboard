import { type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { expect, test } from 'vitest'
import type { CanvasLayoutCore } from '../../canvas-core.js'
import type { SpatialContentCache } from '../../layout/layout-options.js'
import type { FittedBlocks } from '../../layout/nodes/mdast-blocks.js'
import { layoutSpatialCanvasWithAnchors } from '../../layout/spatial-canvas.js'
import { createSpatialTheme } from '../../theme/spatial-theme.js'
import { fakeLayoutCore } from '../fake-layout-core.js'
import { createFakeMeasure } from '../fake-measure.js'
import { built, requireWasm, wasmBytes } from './glue.js'

/**
 * A drag frame through the whole layout (ADR-0054 step 7, S15n): a working
 * board of Markdown bodies laid out again with one node moved, as the editor
 * lays its canvas out on every committed move. Each iteration moves the
 * dragged node one step further, so no layout repeats the last one whole.
 *
 * Four rows over the same frames: the TypeScript with no content cache and
 * with a warm one (what the editor runs today), the Rust core handed no
 * cache, and the core handed the caller's content cache. Before the core kept a cache of its own
 * the last two did the same work; their gap is what the resident cache buys.
 *
 * Run with `pnpm bench`, after `pnpm rust:build:wasm:oracle`; without the
 * artifact the case is skipped.
 */
const BODIES = [
  '# Heading\n\nA paragraph with **bold** and _emphasis_ that wraps across the box.',
  '- one\n- two\n  - nested with `code`\n- three',
  '> A quoted line long enough to wrap inside a node of this width, twice over.',
  '| a | b |\n| --- | --- |\n| 1 | 22 |\n| 333 | 4 |',
  'Plain prose that runs on for a while so the typesetter has lines to break.',
  '1. first\n2. second\n3. third, with a [link](https://example.com)',
]

function board(dx: number): SpatialCanvas {
  const nodes: SpatialNode[] = []
  for (let i = 0; i < 36; i += 1) {
    const x = (i % 6) * 300 + (i === 0 ? dx : 0)
    const y = Math.floor(i / 6) * 220
    nodes.push(
      textNode({ id: `n${i}`, x, y, width: 240, height: 160, text: BODIES[i % BODIES.length] }),
    )
  }
  const edges: CanvasEdge[] = []
  for (let i = 0; i + 1 < 36; i += 3) {
    edges.push({ id: `e${i}`, from: { node: `n${i}` }, to: { node: `n${i + 1}`, end: 'arrow' } })
  }
  return { nodes, edges } as SpatialCanvas
}

function memo(): SpatialContentCache {
  const held = new Map<string, FittedBlocks>()
  return { get: (key) => held.get(key), set: (key, value) => void held.set(key, value) }
}

const measure = createFakeMeasure()
const appearance = createSpatialTheme({ mode: 'light' })

test.runIf(built)(
  'a drag frame, the TypeScript against the core',
  { timeout: 0 },
  async ({ bench }) => {
    const real = coreFrom(requireWasm() as unknown as CoreGlue, wasmBytes())
    let answered = 0
    const counting: CanvasLayoutCore = {
      layoutSpatialCanvas(...args: Parameters<CanvasLayoutCore['layoutSpatialCanvas']>) {
        const answer = real.layoutSpatialCanvas(...args)
        if (!('refused' in answer)) answered += 1
        return answer
      },
    }
    const core = fakeLayoutCore({ routing: real, layout: counting })
    const tsCache = memo()
    const coreCache = memo()
    let frame = 0
    const next = () => board((frame++ % 40) * 4)
    const ts = (contentCache?: SpatialContentCache) => () =>
      layoutSpatialCanvasWithAnchors(next(), { measure, appearance, contentCache })
    const rust = (contentCache?: SpatialContentCache) => () =>
      layoutSpatialCanvasWithAnchors(next(), { measure, appearance, core, contentCache })

    // Judged before timed: the core answers every frame, and draws what the
    // TypeScript draws, cached or not.
    const reference = layoutSpatialCanvasWithAnchors(board(8), { measure, appearance })
    for (const contentCache of [undefined, coreCache, coreCache]) {
      const laid = layoutSpatialCanvasWithAnchors(board(8), {
        measure,
        appearance,
        core,
        contentCache,
      })
      expect(laid.scene).toEqual(reference.scene)
    }
    expect(answered).toBe(3)

    await bench.compare(
      bench('TypeScript, no content cache', ts(undefined)),
      bench('TypeScript, warm content cache', ts(tsCache)),
      bench('Rust core, no content cache', rust(undefined)),
      bench('Rust core, the content cache handed over', rust(coreCache)),
    )
  },
)
