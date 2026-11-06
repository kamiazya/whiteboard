// On a phone every drawing tool is on screen at once: none sits behind a
// sideways scroll the dock gives no cue for. Rendered on an emulated finger,
// so the dock is the 44px-control dock a phone actually draws.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { HistoryCluster } from '../../components/history-cluster/HistoryCluster.js'
import { emulateCoarsePointer } from '../../test-utils/coarse-pointer.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import '../../index.css'

afterEach(async () => {
  await emulateCoarsePointer(false)
  cleanup()
})

const empty: SpatialCanvas = { nodes: [], edges: [] }

const PHONE_PROPS = {
  fileRefOptions: [],
  onAddImage: async () => ({ ok: true as const, ref: 'asset:test' }),
  paletteLeading: <HistoryCluster onUndo={() => {}} onRedo={() => {}} canUndo canRedo />,
}

const TOOLS = ['hand', 'select', 'connect', 'draw', 'eraser'] as const

/** The part of `el` no clipping ancestor hides, as a width; its own width when nothing clips it. */
function unclippedWidth(el: HTMLElement): number {
  const own = el.getBoundingClientRect()
  let left = own.left
  let right = own.right
  for (let at = el.parentElement; at !== null; at = at.parentElement) {
    if (getComputedStyle(at).overflowX === 'visible') continue
    const clip = at.getBoundingClientRect()
    left = Math.max(left, clip.left)
    right = Math.min(right, clip.right)
  }
  return Math.max(0, right - left)
}

describe.each([360, 390, 412])('the dock on a %ipx-wide phone', (width) => {
  it('shows every tool whole, at the touch size, without scrolling', async () => {
    await emulateCoarsePointer(true)
    const { Host } = makeEditorHost({
      initial: empty,
      size: { width, height: 839 },
      editorProps: PHONE_PROPS,
    })
    const { container } = render(<Host />)
    const dock = container.querySelector<HTMLElement>('[data-testid="tool-palette"]')
    const frame = (container.firstElementChild as HTMLElement).getBoundingClientRect()
    expect(dock).not.toBeNull()
    for (const tool of TOOLS) {
      const button = container.querySelector<HTMLElement>(`[data-testid="${tool}-tool-button"]`)
      expect(button, tool).not.toBeNull()
      const rect = (button as HTMLElement).getBoundingClientRect()
      expect(rect.width, `${tool} width`).toBeGreaterThanOrEqual(44)
      expect(unclippedWidth(button as HTMLElement), `${tool} is cut off`).toBeGreaterThanOrEqual(
        rect.width - 0.5,
      )
      expect(rect.left >= frame.left && rect.right <= frame.right, `${tool} off screen`).toBe(true)
    }
    // And the rest of the dock keeps the touch size too: nothing was bought by shrinking it.
    const buttons = [...(dock as HTMLElement).querySelectorAll<HTMLElement>('button')]
    expect(buttons.length).toBeGreaterThan(8)
    for (const button of buttons) {
      expect(button.getBoundingClientRect().width).toBeGreaterThanOrEqual(44)
      expect(unclippedWidth(button)).toBeGreaterThanOrEqual(43.5)
    }
  })
})
