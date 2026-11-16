/**
 * The note preview reaches the Rust core (ADR-0054 step 7, S18c): the Read
 * pane the markdown editor draws — its measurer, its document style, its app
 * theme, its reference bundle, its math fragments, a board embedded in it —
 * is a note the core's markdown entry is handed; and so are the rail's
 * outline and a row's picture, which the layout worker lays out through the
 * same `render-preview.ts` calls this page makes; and so is a comment's
 * prose, in the card and in the rail. An option no request carries would
 * throw and fail the render, and the core is asked for every note.
 */

import {
  fragmentAskKey,
  type LayoutCore,
  layoutMarkdownDocument,
  type MarkdownLayoutCore,
  referenceSeamsFromWire,
  referenceWire,
} from '@kamiazya/whiteboard-canvas-render'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { layoutMarkdownOutline, renderMarkdownPreview } from '../../lib/render-preview.js'
import { layoutCoreReady } from '../../lib/spatial/layout-core.js'
import { webLayoutBoards } from '../../test-utils/web-layout-boards.js'
import { CommentBody } from '../annotations/CommentBody.js'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

const loaded: LayoutCore | undefined = await layoutCoreReady()

it('loads the core before a note is laid out', () => {
  expect(loaded).toBeDefined()
})

const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVS0'
const BOARD = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const board = webLayoutBoards()[0]?.canvas
const NOTE = [
  '# Release plan',
  '',
  `Ship with **care**, \`flags\` on, and read [[${OTHER}]] first.`,
  '',
  '- one',
  '- two',
  '',
  '```ts',
  'const x = 1',
  '```',
  '',
  '$$',
  'x^2',
  '$$',
  '',
  `![[${BOARD}]]`,
  '',
].join('\n')
const references = () =>
  referenceSeamsFromWire(
    referenceWire(
      new Map([
        [OTHER, { documentId: OTHER, name: 'Other note', body: 'hello' }],
        [BOARD, { documentId: BOARD, name: 'Board', canvas: board }],
      ]),
    ),
  )

/** Counts the notes the loaded core is asked for. */
function asked(core: LayoutCore): { count: () => number; restore: () => void } {
  const spy = vi.spyOn(core.markdown as MarkdownLayoutCore, 'layoutMarkdown')
  return { count: () => spy.mock.calls.length, restore: () => spy.mockRestore() }
}

it('hands the core the Read preview, the rail and a row picture', async () => {
  const core = loaded as LayoutCore
  expect(board).toBeDefined()
  for (const theme of ['light', 'dark'] as const) {
    const calls = asked(core)
    try {
      const { container } = render(
        <div style={{ width: 900, height: 900 }}>
          <MarkdownEditor
            theme={theme}
            value={NOTE}
            onChange={() => {}}
            previewDebounceMs={0}
            initialViewMode="read"
            references={references()}
          />
        </div>,
      )
      const pane = () => container.querySelector('[data-testid="markdown-preview-pane"]')
      await expect.poll(() => pane()?.textContent ?? '').toContain('Release plan')
      // The fragment lands, and the layout that draws it is the core's too.
      await expect
        .poll(() => pane()?.querySelector('[data-mml-node="math"]') !== null, {
          timeout: 20_000,
        })
        .toBe(true)
      const measure = createBrowserMeasureText()
      layoutMarkdownOutline(NOTE, { measure, maxWidth: 320 })
      renderMarkdownPreview(NOTE, { measure, maxWidth: 480, theme, references: references() })
      expect(calls.count(), theme).toBeGreaterThanOrEqual(3)
    } finally {
      calls.restore()
      cleanup()
    }
  }
}, 60_000)

it("lays the preview's note out as the TypeScript does, in this browser's measure", () => {
  const core = loaded as LayoutCore
  const measure = createBrowserMeasureText()
  const fragments = [
    [fragmentAskKey({ kind: 'math', value: 'x^2' }), { svg: '<g/>', height: 40 }],
  ] as const
  for (const mode of ['light', 'dark'] as const) {
    // As `renderMarkdownPreview` hands it, short of the core.
    const options = {
      measure,
      maxWidth: 640,
      mode,
      style: 'document' as const,
      references: references(),
      fragments,
    }
    const ts = layoutMarkdownDocument(NOTE, options)
    expect(ts?.nodes.length).toBeGreaterThan(0)
    expect(layoutMarkdownDocument(NOTE, { ...options, core }), mode).toEqual(ts)
  }
}, 30_000)

it("hands the core a comment's prose, in the card and in the rail", async () => {
  const core = loaded as LayoutCore
  const calls = asked(core)
  try {
    const prose =
      'Please **tighten** this, rename `flags`, and see the [docs](https://example.com).'
    const { container } = render(
      <div style={{ width: 320 }}>
        <CommentBody body={prose} />
        <CommentBody body={prose} compact />
      </div>,
    )
    await expect.poll(() => container.querySelectorAll('[data-comment-body] svg').length).toBe(2)
    expect(calls.count()).toBeGreaterThanOrEqual(2)
  } finally {
    calls.restore()
  }
}, 30_000)
