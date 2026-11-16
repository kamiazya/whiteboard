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

/** `board` laid out through the core and by the TypeScript composer, the core's answers counted. */
function lay(core: WebCore, board: WebLayoutBoard) {
  let answered = 0
  const layout: CanvasLayoutCore = {
    layoutSpatialCanvas(request, highlight, measure) {
      const answer = core.layoutSpatialCanvas(request, highlight, measure)
      if (!('declined' in answer)) answered += 1
      return answer
    },
  }
  const switched: LayoutCore = { routing: core, layout, markdown: core, query: core }
  const measure = createBrowserMeasureText()
  const options = {
    ...editorLayoutBase({ measure }),
    threads: board.threads,
    proposals: board.proposals,
  }
  const laid = layoutSpatialCanvasWithAnchors(board.canvas, { ...options, core: switched })
  const reference = layoutSpatialCanvasWithAnchors(board.canvas, { ...options, core: undefined })
  return { laid, reference, answered }
}

describe('the whole layout measured by the browser through the core', () => {
  it('finds the staged artifact where the pipeline promised it', () => {
    if ('failure' in real) throw real.failure
  })

  it.skipIf('failure' in real)('answers every editor board as the TypeScript does', async () => {
    if ('failure' in real) return
    await ensureViewerFontLoaded()
    const boards = webLayoutBoards()
    for (const board of boards) {
      const rust = lay(real.core, board)
      expect(rust.answered, board.name).toBe(1)
      expect(rust.laid.scene, board.name).toEqual(rust.reference.scene)
      expect(Object.fromEntries(rust.laid.anchors), board.name).toEqual(
        Object.fromEntries(rust.reference.anchors),
      )
    }
    expect(boards.length).toBeGreaterThanOrEqual(8)
  })
})
