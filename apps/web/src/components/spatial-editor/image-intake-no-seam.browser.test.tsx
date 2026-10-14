// A canvas whose host stores no images still owns a file dropped or pasted on
// it. Left uncancelled, a dropped file is opened by the browser in place of
// the page, and a pasted picture does nothing and says nothing.
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'chart.png', { type: 'image/png' })

function bareHost() {
  const { Host, latest } = makeEditorHost({ initial: { nodes: [], edges: [] } })
  const { container } = render(<Host />)
  const notice = () => container.querySelector('[data-testid="image-notice"]')
  return { root: rootOf(container), notice, latest }
}

function withFile(file: File): DataTransfer {
  const dataTransfer = new DataTransfer()
  dataTransfer.items.add(file)
  return dataTransfer
}

it('without an image seam, a file drag is cancelled and its drop refused aloud', async () => {
  const { root, notice, latest } = bareHost()
  const dataTransfer = withFile(png())
  const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer })
  const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })

  root.dispatchEvent(over)
  root.dispatchEvent(drop)

  expect(over.defaultPrevented).toBe(true)
  expect(drop.defaultPrevented).toBe(true)
  await vi.waitFor(() =>
    expect(notice()?.textContent).toBe("Images can't be added to this canvas."),
  )
  expect(latest.canvas.nodes).toHaveLength(0)
})

it('without an image seam, a non-image file drop is still cancelled', () => {
  const { root } = bareHost()
  const text = new File(['hello'], 'notes.txt', { type: 'text/plain' })
  const drop = new DragEvent('drop', {
    bubbles: true,
    cancelable: true,
    dataTransfer: withFile(text),
  })

  root.dispatchEvent(drop)

  expect(drop.defaultPrevented).toBe(true)
})

it('without an image seam, a pasted image is refused aloud', async () => {
  const { root, notice, latest } = bareHost()
  const paste = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: withFile(png()),
  })

  root.dispatchEvent(paste)

  expect(paste.defaultPrevented).toBe(true)
  await vi.waitFor(() =>
    expect(notice()?.textContent).toBe("Images can't be added to this canvas."),
  )
  expect(latest.canvas.nodes).toHaveLength(0)
})
