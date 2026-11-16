/**
 * A layout the Rust core refuses is drawn as a notice on every web surface
 * (ADR-0054 step 7, owner decision q81, D7d): a board past the element cap in
 * the editor and in version history, and a note whose referenced bodies are
 * past the bodies cap in the markdown preview. Under `rust` the surface draws
 * the notice in place of the layout; under `differential` the TypeScript
 * still draws it, as the oracle, so each case sets `rust` for the layout it
 * draws. Where no core is loaded (a run under `ts`) it skips, and a run that
 * asked for one (`CORE_REQUIRED`) fails instead when the core did not load.
 */

import {
  type CoreImpl,
  type LayoutCore,
  referenceSeamsFromWire,
  referenceWire,
  refusalCopy,
} from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { layoutCoreReady } from '../lib/spatial/layout-core.js'
import { CORE_REQUIRED } from '../test-utils/core-required.js'
import { MarkdownEditor } from './markdown-editor/MarkdownEditor.js'
import { SpatialEditor } from './spatial-editor/SpatialEditor.js'
import { VersionPreview } from './VersionPreview.js'

afterEach(cleanup)

const loaded: LayoutCore | undefined = await layoutCoreReady()
const LAYOUT = loaded?.impl.layoutSpatialCanvas ?? 'ts'

it.runIf(CORE_REQUIRED)('loads the core the pipeline asked for before a refusal is drawn', () => {
  expect(loaded).toBeDefined()
})

/** One more box than a request's own canvas may hold: refused before any layout runs. */
const PAST_THE_ELEMENT_CAP: SpatialCanvas = {
  nodes: Array.from({ length: 4097 }, (_, i) =>
    textNode({
      id: `n${i}`,
      x: (i % 64) * 120,
      y: Math.floor(i / 64) * 80,
      width: 100,
      height: 60,
      text: `b${i}`,
    }),
  ),
  edges: [],
}

const tooMany = refusalCopy({ code: 'input-too-large', reason: 'too-many-elements' })

/** `run` with the loaded core's switch for `fn` reading `rust`, restored after. */
async function underRust(
  fn: 'layoutSpatialCanvas' | 'layoutMarkdown',
  run: () => Promise<void>,
): Promise<void> {
  const impl = (loaded as LayoutCore).impl as Record<string, CoreImpl | undefined>
  const before = impl[fn]
  impl[fn] = 'rust'
  try {
    await run()
  } finally {
    impl[fn] = before
    cleanup()
  }
}

/** The text a container draws in SVG, its runs joined by spaces. */
const drawnText = (root: Element | null | undefined) =>
  [...(root?.querySelectorAll('svg text') ?? [])].map((run) => run.textContent).join(' ')

/** Whether two client rects overlap by any area. */
const intersects = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/** A board past the element cap, placed far from the origin. */
const FAR_AWAY: SpatialCanvas = {
  ...PAST_THE_ELEMENT_CAP,
  nodes: PAST_THE_ELEMENT_CAP.nodes.map((node) => ({
    ...node,
    x: node.x + 9000,
    y: node.y - 6000,
  })),
}

it.skipIf(LAYOUT === 'ts')(
  'shows the editor notice clear of its chrome, wherever the board sits and at any zoom',
  async () => {
    await underRust('layoutSpatialCanvas', async () => {
      const { container } = render(
        <div style={{ width: 900, height: 560 }}>
          <SpatialEditor canvas={FAR_AWAY} onChange={() => {}} theme="dark" />
        </div>,
      )
      const notice = () => container.querySelector('[data-testid="canvas-refusal-notice"]')
      await expect.poll(() => notice()?.textContent ?? '').toContain(tooMany.title)
      expect(notice()?.textContent).toContain(tooMany.detail)
      // Drawn once, on screen: the canvas space holds none of it.
      expect(drawnText(container)).not.toContain(tooMany.title)
      expect(drawnText(container)).not.toContain('b4096')
      const chrome = () =>
        ['shortcuts-button', 'tool-palette', 'minimap'].map((id) => {
          const element = container.querySelector(`[data-testid="${id}"]`)
          expect(element, id).not.toBeNull()
          return { id, rect: (element as HTMLElement).getBoundingClientRect() }
        })
      const clear = () => {
        const box = (notice() as HTMLElement).getBoundingClientRect()
        expect(box.width * box.height).toBeGreaterThan(0)
        for (const { id, rect } of chrome()) expect(intersects(box, rect), id).toBe(false)
      }
      clear()
      // Zoom in and out, pan, and fit, as a mouse does; each must move the view.
      const editor = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
      const view = () =>
        container.querySelector('[data-testid="viewport-transform"]')?.getAttribute('style') ?? ''
      const wheels = [
        { deltaX: 0, deltaY: -400, ctrlKey: true },
        { deltaX: 0, deltaY: 600, ctrlKey: true },
        { deltaX: 700, deltaY: -500, ctrlKey: false },
      ]
      for (const wheel of wheels) {
        const before = view()
        editor.dispatchEvent(
          new WheelEvent('wheel', { bubbles: true, clientX: 450, clientY: 280, ...wheel }),
        )
        await expect.poll(view).not.toBe(before)
        clear()
      }
      const beforeFit = view()
      ;(container.querySelector('[data-testid="zoom-fit-button"]') as HTMLElement).click()
      await expect.poll(view).not.toBe(beforeFit)
      clear()
    })
  },
  60_000,
)

it.skipIf(LAYOUT === 'ts')(
  'draws a board past the element cap as the notice in version history',
  async () => {
    await underRust('layoutSpatialCanvas', async () => {
      const { container } = render(
        <div style={{ width: 800, height: 600 }}>
          <VersionPreview past={{ kind: 'spatial', canvas: PAST_THE_ELEMENT_CAP }} theme="light" />
        </div>,
      )
      const viewer = () => container.querySelector('[data-testid="canvas-viewer"]')
      await expect.poll(() => drawnText(viewer())).toContain(tooMany.title)
    })
  },
  60_000,
)

it.skipIf(LAYOUT === 'ts')(
  'draws a note whose referenced bodies are past the bodies cap as the notice in the preview',
  async () => {
    // Four bodies of 800 KiB: past the 3 MiB the bodies may hold together, and
    // counted whether or not the note embeds them.
    const body = 'a'.repeat(800 * 1024)
    const entries = new Map(
      [0, 1, 2, 3].map((i) => [`d${i}`, { documentId: `D${i}`, body }] as const),
    )
    const references = referenceSeamsFromWire(referenceWire(entries))
    const bodies = refusalCopy({ code: 'input-too-large', reason: 'bodies' })
    await underRust('layoutMarkdown', async () => {
      const { container } = render(
        <div style={{ width: 900, height: 900 }}>
          <MarkdownEditor
            theme="light"
            value={'# Plan\n\nShip it.\n'}
            onChange={() => {}}
            previewDebounceMs={0}
            initialViewMode="read"
            references={references}
          />
        </div>,
      )
      const pane = () => container.querySelector('[data-testid="markdown-preview-pane"]')
      await expect.poll(() => drawnText(pane())).toContain(bodies.title)
      expect(pane()?.textContent ?? '').not.toContain('Ship it.')
    })
  },
  60_000,
)
