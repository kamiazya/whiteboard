// A standing guarantee that the editor's chrome fits, at any size.
//
// The overview/dock overlap was not a one-off: the dock's own header records
// an earlier collision between independently positioned bottom islands, and
// the overview reproduced it from the other side. Both were found by looking
// at a phone. This grid looks instead.
//
// Chrome enumerates ITSELF: every persistent overlay already carries
// `data-editor-overlay` so the editor root can skip hit-testing it, and that
// marker is what this test collects. A future overlay joins the matrix by
// existing — nobody has to remember to add it here.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { HistoryCluster } from '@/components/history-cluster/HistoryCluster'
import { dockControlSizesPx } from '@/components/ui/dock-button'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

/** Spread out, so the overview has real content to draw and cannot opt out. */
const canvas0: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 120, height: 80, text: 'A' },
    { id: 'b', type: 'text', x: 900, y: 700, width: 120, height: 80, text: 'B' },
  ],
  edges: [],
}

/**
 * Sizes a phone, tablet, or split-pane editor actually takes. The narrow end
 * is the point: 320 is the smallest width still worth supporting, and every
 * collision so far appeared below 768.
 *
 * 640 earns its place twice over. Measured, the dock is 250px wide and the
 * overview claims the rightmost 176px, so they start touching below 602 on a
 * mouse but below 650 on a touch device. 640 sits in that gap — the only band
 * where the touch inflation below decides the outcome. Drop it and a
 * threshold chosen from fine-pointer reasoning alone passes the grid.
 */
const WIDTHS = [320, 360, 390, 414, 540, 640, 768, 834, 1024, 1280] as const
const HEIGHTS = [480, 844] as const

/**
 * Assembled the way a page assembles it, not the way a focused test would.
 *
 * The dock's leading slot is filled by the HOST, so an editor rendered without
 * one is measurably narrower than any real screen shows — narrow enough that a
 * collision reproduces here as a pass. `fileRefOptions` and `onAddImage` are
 * present for the same reason: both add an entry to the "+" menu, and the menu
 * is chrome that has to fit too.
 */
function Host({ width, height }: { width: number; height: number }) {
  const [canvas, setCanvas] = useState(canvas0)
  return (
    <div style={{ width, height }}>
      <SpatialEditor
        defaultTool="select"
        canvas={canvas}
        onChange={setCanvas}
        theme="light"
        fileRefOptions={[]}
        onAddImage={async () => 'asset:test'}
        paletteLeading={<HistoryCluster onUndo={() => {}} onRedo={() => {}} canUndo canRedo />}
      />
    </div>
  )
}

interface Chrome {
  readonly name: string
  readonly rect: DOMRect
}

/**
 * The OUTERMOST overlays only. A menu that opens inside the dock is marked
 * too, and counting it separately would report every open menu as overlapping
 * its own container.
 */
function collectChrome(root: HTMLElement): Chrome[] {
  return [...root.querySelectorAll<HTMLElement>('[data-editor-overlay]')]
    .filter((el) => el.parentElement?.closest('[data-editor-overlay]') == null)
    .map((el) => ({
      name: el.dataset.testid ?? el.getAttribute('aria-label') ?? el.tagName.toLowerCase(),
      rect: el.getBoundingClientRect(),
    }))
    .filter((entry) => entry.rect.width > 0 && entry.rect.height > 0)
}

/**
 * The dock as it would render on a touch device.
 *
 * Its controls grow one step on `pointer: coarse` to clear the 44px touch
 * floor, and the runner cannot emulate that media feature — so the widest,
 * most collision-prone dock is the one this test can never render. Inflating
 * the measured rect by the known per-control delta covers it anyway: width by
 * the delta once per control, height by the delta once. The dock is centred,
 * so it grows symmetrically about its own midpoint.
 */
function asTouchDock(rect: DOMRect, controlCount: number): DOMRect {
  const { fine, coarse } = dockControlSizesPx()
  const delta = coarse - fine
  const width = rect.width + delta * controlCount
  const height = rect.height + delta
  return new DOMRect(
    rect.x - (width - rect.width) / 2,
    rect.y - (height - rect.height),
    width,
    height,
  )
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)
}

/**
 * A centred element in an odd-width container legitimately lands on a half
 * pixel, so containment is judged to within one. Anything larger is a real
 * overflow — this is a tolerance for layout arithmetic, not a fudge factor for
 * chrome that genuinely sticks out.
 */
const SUBPIXEL_TOLERANCE_PX = 1

/**
 * The dock is unconditional, so its absence means the collection broke rather
 * than that the layout changed — and every check in this file is written as
 * "no pair overlaps" / "every overlay fits", both of which an empty collection
 * satisfies. Without this the grid would go green the moment it stopped
 * looking at anything.
 */
function collectChromeOrFail(root: HTMLElement, at: string): Chrome[] {
  const chrome = collectChrome(root)
  expect(
    chrome.map((entry) => entry.name),
    `no dock found at ${at}; every geometry check below would be vacuous`,
  ).toContain('tool-palette')
  return chrome
}

const describeRect = (r: DOMRect) =>
  `[${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}]`

const cases = WIDTHS.flatMap((width) => HEIGHTS.map((height) => ({ width, height })))

describe.each(cases)('editor chrome at $width x $height', ({ width, height }) => {
  it('keeps every overlay inside the editor', () => {
    const { container } = render(<Host width={width} height={height} />)
    const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
    const bounds = root.getBoundingClientRect()

    for (const { name, rect } of collectChromeOrFail(root, `${width}x${height}`)) {
      expect(
        rect.left >= bounds.left - SUBPIXEL_TOLERANCE_PX &&
          rect.right <= bounds.right + SUBPIXEL_TOLERANCE_PX &&
          rect.top >= bounds.top - SUBPIXEL_TOLERANCE_PX &&
          rect.bottom <= bounds.bottom + SUBPIXEL_TOLERANCE_PX,
        `${name} ${describeRect(rect)} escapes the editor ${describeRect(bounds)}`,
      ).toBe(true)
    }
  })

  it('leaves no two overlays on top of each other, touch sizing included', () => {
    const { container } = render(<Host width={width} height={height} />)
    const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
    const controlCount = root.querySelectorAll('[data-testid="tool-palette"] button').length

    const chrome = collectChromeOrFail(root, `${width}x${height}`).map((entry) =>
      entry.name === 'tool-palette'
        ? { ...entry, rect: asTouchDock(entry.rect, controlCount) }
        : entry,
    )

    for (let i = 0; i < chrome.length; i++) {
      for (let j = i + 1; j < chrome.length; j++) {
        const a = chrome[i]
        const b = chrome[j]
        if (a === undefined || b === undefined) continue
        expect(
          overlaps(a.rect, b.rect),
          `${a.name} ${describeRect(a.rect)} overlaps ${b.name} ${describeRect(b.rect)}`,
        ).toBe(false)
      }
    }
  })
})

describe('the assumptions this grid rests on', () => {
  // A grid that silently stopped finding any chrome would pass forever.
  it('finds the dock, and the overview once there is room for it', () => {
    const { container } = render(<Host width={1280} height={844} />)
    const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
    const names = collectChrome(root).map((entry) => entry.name)

    expect(names).toContain('tool-palette')
    expect(names).toContain('minimap')
  })

  it('reads both dock sizes out of the class the dock actually uses', () => {
    const { fine, coarse } = dockControlSizesPx()
    expect(fine).toBe(36)
    expect(coarse).toBe(44)
  })
})
