// The whole layout through the real Rust core in a browser, measured by the
// browser's own measurer, which the core asks mid-layout through its one host
// import (ADR-0054 step 7). The boards are the editor's shapes: plain labels,
// CJK, a Markdown body, a code fence, comments, proposals, file nodes, and a
// board at an ordinary working size.
//
// The artifact is built in the pipeline, never committed, and every browser
// run needs it: a missing artifact FAILS this file's first test, and the rest
// skip, saying so (as layout-core.browser.test.ts does).

import {
  type CanvasLayoutCore,
  describeMeasure,
  type LayoutCore,
  layoutSpatialCanvasWithAnchors,
} from '@kamiazya/whiteboard-canvas-render'
import { ensureViewerFontLoaded } from '@kamiazya/whiteboard-canvas-viewer/font-loading'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer/measure-text'
import { describe, expect, it } from 'vitest'
import { type WebLayoutBoard, webLayoutBoards } from '../../test-utils/web-layout-boards.js'
import { editorLayoutBase } from './scene-render-core.js'
import type { WebCore } from './web-core.js'

async function loadRealCore(): Promise<{ core: WebCore } | { failure: unknown }> {
  try {
    // lazy-import: the artifact may be absent, and a static import of the module that names it would fail the whole file to load instead of skipping
    const { loadWebCore } = await import('./layout-core-source.js')
    return { core: await loadWebCore(fetch) }
  } catch (err) {
    return { failure: err }
  }
}
const real = await loadRealCore()

/**
 * `board` laid out through the core with the browser's measurer, named `host`,
 * so the core asks it mid-layout: the core's answers counted, and every
 * advance the measurer answered recorded by the text it was asked for.
 */
function lay(core: WebCore, board: WebLayoutBoard) {
  let answered = 0
  const layout: CanvasLayoutCore = {
    layoutSpatialCanvas(request, highlight, measure) {
      const answer = core.layoutSpatialCanvas(request, highlight, measure)
      if (!('refused' in answer)) answered += 1
      return answer
    },
  }
  const switched: LayoutCore = { routing: core, layout, markdown: core, query: core }
  const browser = createBrowserMeasureText()
  const advances = new Map<string, Set<number>>()
  const measure = describeMeasure(
    (text, font) => {
      const metrics = browser(text, font)
      const seen = advances.get(text) ?? new Set<number>()
      seen.add(metrics.advanceWidth)
      advances.set(text, seen)
      return metrics
    },
    { kind: 'host' },
  )
  const laid = layoutSpatialCanvasWithAnchors(board.canvas, {
    ...editorLayoutBase({ measure }),
    threads: board.threads,
    proposals: board.proposals,
    core: switched,
  })
  return { laid, advances, answered }
}

/** Every text run in `nodes`, at any depth. */
function textRuns(nodes: readonly unknown[]): { text: string; w: number }[] {
  const runs: { text: string; w: number }[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const node = value as { kind?: unknown; text?: unknown; bbox?: { w?: unknown } }
    if (
      node.kind === 'textRun' &&
      typeof node.text === 'string' &&
      typeof node.bbox?.w === 'number'
    ) {
      runs.push({ text: node.text, w: node.bbox.w })
    }
    for (const child of Object.values(value)) visit(child)
  }
  visit(nodes)
  return runs
}

describe('the whole layout measured by the browser through the core', () => {
  it('finds the staged artifact where the pipeline promised it', () => {
    if ('failure' in real) throw real.failure
  })

  // The TypeScript layout this was compared against is gone (S18h), so what is
  // left to hold is that the browser's answers ARE the geometry: a run the core
  // measured whole is as wide as the browser said that text is. A host import
  // that fell back to an estimate, or lost the answer crossing back, draws
  // runs at widths the browser never answered.
  it.skipIf('failure' in real)('draws each board at the widths the browser answered', async () => {
    if ('failure' in real) return
    await ensureViewerFontLoaded()
    const boards = webLayoutBoards()
    let matched = 0
    for (const board of boards) {
      const rust = lay(real.core, board)
      expect(rust.answered, board.name).toBe(1)
      expect(rust.advances.size, board.name).toBeGreaterThan(0)
      for (const run of textRuns(rust.laid.scene.nodes)) {
        const answered = rust.advances.get(run.text)
        if (answered === undefined) continue
        const closest = Math.min(...[...answered].map((w) => Math.abs(w - run.w)))
        expect(closest, `${board.name}: ${JSON.stringify(run.text)}`).toBeLessThan(1e-6)
        matched += 1
      }
    }
    expect(boards.length).toBeGreaterThanOrEqual(8)
    // Enough runs measured whole that the check above is not vacuous.
    expect(matched).toBeGreaterThan(boards.length)
  })
})
