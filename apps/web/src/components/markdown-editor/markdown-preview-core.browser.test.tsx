/**
 * The note preview reaches the Rust core (ADR-0054 step 7, S18c): the Read
 * pane the markdown editor draws — its measurer, its document style, its app
 * theme, its reference bundle, its math fragments, a board embedded in it —
 * is a note the markdown switch hands the core, never one it skips; and so
 * are the rail's outline and a row's picture, which the layout worker lays
 * out through the same `render-preview.ts` calls this page makes.
 *
 * The switch reports a layout the core did not answer at debug, by class;
 * this counts them and requires none, with the core asked for every note.
 * Under the CI browser job's `differential` + `throw` a difference fails the
 * layout. Where no core is loaded (a run under `ts`) it skips, and a run that
 * set `VITE_WHITEBOARD_CORE` fails instead when the core did not load.
 */

import {
  type CoreImpl,
  fragmentAskKey,
  type LayoutCore,
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
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

const REQUIRED = (import.meta.env.VITE_WHITEBOARD_CORE ?? '') !== ''
const loaded: LayoutCore | undefined = await layoutCoreReady()
const MARKDOWN = loaded?.impl.layoutMarkdown ?? 'ts'

it.runIf(REQUIRED)('loads the core the pipeline asked for before a note is laid out', () => {
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

/** What the switch reports at debug from now until restored: one `kind:reason` per note the core did not answer. */
function unanswered(): { readonly classes: string[]; readonly restore: () => void } {
  const classes: string[] = []
  const spy = vi.spyOn(console, 'debug').mockImplementation((...args: unknown[]) => {
    const [message, report] = args as [string, { kind?: string; reason?: string } | undefined]
    if (typeof message === 'string' && message.includes('did not answer this layout')) {
      classes.push(`${report?.kind}:${report?.reason}`)
    }
  })
  return { classes, restore: () => spy.mockRestore() }
}

/** Counts the notes the loaded core is asked for. */
function asked(core: LayoutCore): { count: () => number; restore: () => void } {
  const spy = vi.spyOn(core.markdown as MarkdownLayoutCore, 'layoutMarkdown')
  return { count: () => spy.mock.calls.length, restore: () => spy.mockRestore() }
}

it.skipIf(MARKDOWN === 'ts')(
  'hands the core the Read preview, the rail and a row picture',
  async () => {
    const core = loaded as LayoutCore
    expect(board).toBeDefined()
    for (const theme of ['light', 'dark'] as const) {
      const reports = unanswered()
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
        expect({ classes: reports.classes, asked: calls.count() >= 3 }, theme).toEqual({
          classes: [],
          asked: true,
        })
      } finally {
        calls.restore()
        reports.restore()
        cleanup()
      }
    }
  },
  60_000,
)

it.skipIf(MARKDOWN === 'ts')(
  'draws the preview byte for byte as the TypeScript does',
  () => {
    const core = loaded as LayoutCore
    const impl = core.impl as { layoutMarkdown?: CoreImpl }
    const before = impl.layoutMarkdown
    const measure = createBrowserMeasureText()
    const fragments = {
      fragments: [
        [fragmentAskKey({ kind: 'math', value: 'x^2' }), { svg: '<g/>', height: 40 }],
      ] as const,
      onFragmentsAsked: () => {},
    }
    const draw = (as: CoreImpl, theme: 'light' | 'dark') => {
      impl.layoutMarkdown = as
      try {
        return renderMarkdownPreview(NOTE, {
          measure,
          maxWidth: 640,
          theme,
          references: references(),
          fragments,
        }).keyed.svg
      } finally {
        impl.layoutMarkdown = before
      }
    }
    for (const theme of ['light', 'dark'] as const) {
      const ts = draw('ts', theme)
      expect(ts).toContain('Release plan')
      expect(draw('rust', theme), theme).toBe(ts)
    }
  },
  30_000,
)
