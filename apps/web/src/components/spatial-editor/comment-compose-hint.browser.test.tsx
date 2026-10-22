// The compose bubble grows with what is typed, and the "Done / Cancel" hint
// that hangs beneath it has to stay beneath it rather than sit over the
// lines the bubble has grown to hold.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const start: SpatialCanvas = {
  nodes: [textNode({ id: 'n1', x: 100, y: 100, width: 200, height: 100, text: 'hello' })],
  edges: [],
}

const LONG =
  'Let us list every place the signup form can fail and decide which of them deserve an inline message rather than a toast so nobody retries a typo'

it('keeps the exit hint below a comment draft that has grown past three lines', async () => {
  const { Host } = makeEditorHost({ initial: start })
  const { container } = render(<Host />)
  const root = rootOf(container)
  const r = root.getBoundingClientRect()
  fireEvent.contextMenu(root, { clientX: r.left + 400, clientY: r.top + 300, button: 2 })
  await userEvent.click(page.getByRole('menuitem', { name: 'Comment here' }))
  const bubble = page.getByTestId('comment-compose')
  await expect.element(bubble).toBeInTheDocument()

  await userEvent.keyboard(LONG)

  await vi.waitFor(() => {
    const bubbleRect = bubble.element().getBoundingClientRect()
    expect(bubbleRect.height).toBeGreaterThan(70)
    const hintRect = page.getByTestId('editor-exit-hint').element().getBoundingClientRect()
    expect(hintRect.top).toBeGreaterThanOrEqual(bubbleRect.bottom - 0.5)
  })
})
