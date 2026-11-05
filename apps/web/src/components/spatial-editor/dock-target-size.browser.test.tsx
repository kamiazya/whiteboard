// The dock's controls keep the size their class declares, however narrow the
// editor: the tool group scrolls rather than squeezing its buttons, and the
// "+" menu's rows clear the 44px touch floor on a coarse pointer as the dock
// does. The runner cannot emulate `pointer: coarse`, so the fine row is
// measured and the coarse row is read from the class it would apply.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { HistoryCluster } from '../../components/history-cluster/HistoryCluster.js'
import { DOCK_BUTTON_CLASS } from '../../components/ui/dock-button.js'
import { controlHeightsPx } from '../../test-utils/control-heights-px.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import '../../index.css'

afterEach(cleanup)

const empty: SpatialCanvas = { nodes: [], edges: [] }

const PHONE_PROPS = {
  fileRefOptions: [],
  onAddImage: async () => ({ ok: true as const, ref: 'asset:test' }),
  paletteLeading: <HistoryCluster onUndo={() => {}} onRedo={() => {}} canUndo canRedo />,
}

it('keeps every dock button its declared width on a phone-wide editor', () => {
  const { Host } = makeEditorHost({
    initial: empty,
    size: { width: 320, height: 640 },
    editorProps: PHONE_PROPS,
  })
  const { container } = render(<Host />)
  const buttons = [
    ...container.querySelectorAll<HTMLElement>('[data-testid="tool-palette"] button'),
  ]
  expect(buttons.length).toBeGreaterThan(6)
  const { fine } = controlHeightsPx(DOCK_BUTTON_CLASS)
  for (const button of buttons) {
    const width = button.getBoundingClientRect().width
    expect(width, `${button.getAttribute('aria-label')} is ${width}px wide`).toBeGreaterThanOrEqual(
      fine - 0.5,
    )
  }
})

it('gives each Add menu row the touch floor on a coarse pointer', async () => {
  const { Host } = makeEditorHost({ initial: empty, editorProps: PHONE_PROPS })
  const { container } = render(<Host />)
  await userEvent.click(container.querySelector('[data-testid="add-button"]') as HTMLElement)
  const rows = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(rows.length).toBeGreaterThan(2)
  for (const row of rows) expect(row.className).toContain('pointer-coarse:min-h-11')
})
