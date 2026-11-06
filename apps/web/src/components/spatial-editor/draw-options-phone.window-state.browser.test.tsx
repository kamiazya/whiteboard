// The Draw options on a phone, on an emulated finger so every option is the
// 44px cell a phone draws: whole rows, a Default swatch that shows the ink it
// gives, width samples that differ, and a strip that neither covers the
// overview's button nor the notes Zoom to fit has just framed.

import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { HistoryCluster } from '../../components/history-cluster/HistoryCluster.js'
import { writeMinimapOpen } from '../../lib/minimap-visibility.js'
import { emulateCoarsePointer } from '../../test-utils/coarse-pointer.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import '../../index.css'

beforeEach(() => writeMinimapOpen(false))
afterEach(async () => {
  await emulateCoarsePointer(false)
  cleanup()
})

/** Two columns of notes, tall enough that a fit reaches the bottom of a phone. */
const notes: SpatialCanvas = {
  nodes: [0, 1, 2, 3].flatMap((row) => [
    textNode({ id: `l${row}`, x: 0, y: row * 160, width: 200, height: 100, text: `L${row}` }),
    textNode({ id: `r${row}`, x: 240, y: row * 160, width: 200, height: 100, text: `R${row}` }),
  ]),
  edges: [],
}

const PHONE_PROPS = {
  fileRefOptions: [],
  onAddImage: async () => ({ ok: true as const, ref: 'asset:test' }),
  paletteLeading: <HistoryCluster onUndo={() => {}} onRedo={() => {}} canUndo canRedo />,
}

async function armDrawOn(width: number) {
  await emulateCoarsePointer(true)
  const { Host } = makeEditorHost({
    initial: notes,
    size: { width, height: 839 },
    editorProps: PHONE_PROPS,
  })
  const { container } = render(<Host />)
  await userEvent.click(page.getByTestId('draw-tool-button'))
  await expect.element(page.getByTestId('draw-options')).toBeVisible()
  return container
}

const strip = (container: HTMLElement) =>
  container.querySelector('[data-testid="draw-options"]') as HTMLElement

function tops(group: Element | null): Set<number> {
  return new Set(
    [...(group?.querySelectorAll('label') ?? [])].map((label) =>
      Math.round(label.getBoundingClientRect().top),
    ),
  )
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)
}

describe.each([360, 412])('the Draw options on a %ipx-wide phone', (width) => {
  it('lays each group out on one whole row of touch-sized options', async () => {
    const container = await armDrawOn(width)
    const colors = strip(container).querySelector('[role="radiogroup"][aria-label="Color"]')
    const widths = strip(container).querySelector('[role="radiogroup"][aria-label="Width"]')
    expect(colors?.querySelectorAll('label').length).toBe(7)
    expect(widths?.querySelectorAll('label').length).toBe(3)
    expect([...tops(colors)]).toHaveLength(1)
    expect([...tops(widths)]).toHaveLength(1)
    for (const label of strip(container).querySelectorAll('label')) {
      expect(label.getBoundingClientRect().width).toBeGreaterThanOrEqual(44)
    }
    const frame = (container.firstElementChild as HTMLElement).getBoundingClientRect()
    const rect = strip(container).getBoundingClientRect()
    expect(rect.left >= frame.left && rect.right <= frame.right).toBe(true)
    // Nothing scrolls out of sight inside the strip either.
    expect(strip(container).scrollWidth).toBeLessThanOrEqual(strip(container).clientWidth + 0.5)
  })

  it('leaves the overview button and the fitted notes uncovered', async () => {
    const container = await armDrawOn(width)
    await userEvent.click(page.getByTestId('zoom-fit-button'))
    const covered = strip(container).getBoundingClientRect()
    const ids = new Set(notes.nodes.map((node) => node.id))
    const drawn = () =>
      [...container.querySelectorAll<SVGGElement>('g[data-wb-key]')].filter((g) =>
        ids.has(g.dataset.wbKey?.split('#')[0] ?? ''),
      )
    await expect
      .poll(() => new Set(drawn().map((g) => g.dataset.wbKey?.split('#')[0])).size)
      .toBe(ids.size)
    await expect
      .poll(() =>
        drawn()
          .filter((g) => overlaps(g.getBoundingClientRect(), covered))
          .map((g) => g.dataset.wbKey),
      )
      .toEqual([])
    const toggle = container.querySelector('[data-testid="minimap-toggle-wrap"]')
    if (toggle !== null) {
      expect(overlaps(toggle.getBoundingClientRect(), covered)).toBe(false)
    }
  })
})

describe('what the Draw options show', () => {
  it('draws Default as a dot of the ink it gives', async () => {
    const container = await armDrawOn(412)
    const swatch = strip(container).querySelector('[title="Default"] span[aria-hidden] span')
    expect(swatch, 'Default swatch').not.toBeNull()
    expect(strip(container).querySelector('[title="Default"] svg')).toBeNull()
    const probe = document.createElement('span')
    probe.style.color = SPATIAL_LIGHT_PALETTE.edgeStroke
    document.body.append(probe)
    const ink = getComputedStyle(probe).color
    probe.remove()
    expect(getComputedStyle(swatch as Element).backgroundColor).toBe(ink)
  })

  it('makes each width sample clearly heavier than the one before', async () => {
    const container = await armDrawOn(412)
    const heights = ['Thin', 'Medium', 'Thick'].map(
      (name) =>
        (
          strip(container).querySelector(`[title="${name}"] span[aria-hidden] span`) as Element
        ).getBoundingClientRect().height,
    )
    // Twice as heavy AND at least 2px heavier: 1.5px against 3px is twice,
    // and still reads as the same grey dash on a phone.
    for (const [lighter, heavier] of [
      [heights[0] ?? 0, heights[1] ?? 0],
      [heights[1] ?? 0, heights[2] ?? 0],
    ] as const) {
      expect(heavier).toBeGreaterThanOrEqual(lighter * 2)
      expect(heavier - lighter).toBeGreaterThanOrEqual(2)
    }
  })
})
