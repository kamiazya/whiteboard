/**
 * A layout the Rust core refuses is drawn as a notice on every web surface
 * (ADR-0054 step 7, owner decision q81, D7d): a board past the element cap in
 * the editor and in version history, and a note whose referenced bodies are
 * past the bodies cap in the markdown preview. Under `rust` the surface draws
 * the notice in place of the layout; under `differential` the TypeScript
 * still draws it, as the oracle, so each case sets `rust` for the layout it
 * draws. Where no core is loaded (a run under `ts`) it skips.
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
import { MarkdownEditor } from './markdown-editor/MarkdownEditor.js'
import { SpatialEditor } from './spatial-editor/SpatialEditor.js'
import { VersionPreview } from './VersionPreview.js'

afterEach(cleanup)

const loaded: LayoutCore | undefined = await layoutCoreReady()
const LAYOUT = loaded?.impl.layoutSpatialCanvas ?? 'ts'

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

it.skipIf(LAYOUT === 'ts')(
  'draws a board past the element cap as the notice, in the editor and in version history',
  async () => {
    await underRust('layoutSpatialCanvas', async () => {
      const { container } = render(
        <div style={{ width: 1000, height: 700 }}>
          <SpatialEditor canvas={PAST_THE_ELEMENT_CAP} onChange={() => {}} theme="dark" />
        </div>,
      )
      await expect.poll(() => drawnText(container)).toContain(tooMany.title)
      expect(drawnText(container)).toContain(tooMany.detail.split(' ').slice(0, 4).join(' '))
      expect(drawnText(container)).not.toContain('b4096')
    })
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
