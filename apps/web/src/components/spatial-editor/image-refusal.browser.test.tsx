// An image the daemon would refuse is refused where the person is looking —
// at the pick, the drop and the paste — and an upload the daemon refuses
// anyway is reported, rather than leaving a click that did nothing.
import { UPLOADABLE_IMAGE_TYPES } from '@kamiazya/whiteboard-daemon-client/api-contracts/files'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ImageStoreResult } from '../../lib/document-file-contract.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)

const avif = () => new File([new Uint8Array([0, 0, 0, 24])], 'photo.avif', { type: 'image/avif' })
const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'chart.png', { type: 'image/png' })

function host(store: (file: File) => Promise<ImageStoreResult>) {
  const stored: File[] = []
  const onAddImage = vi.fn((file: File) => {
    stored.push(file)
    return store(file)
  })
  const mounted = makeEditorHost({
    initial: { nodes: [], edges: [] },
    editorProps: { onAddImage },
  })
  const { Host, latest } = mounted
  const { container } = render(<Host />)
  const notice = () => container.querySelector('[data-testid="image-notice"]')
  const input = () =>
    container.querySelector('[data-testid="image-file-input"]') as HTMLInputElement
  return { container, latest, onAddImage, notice, input }
}

it('offers the picker exactly the types the daemon stores', () => {
  const { input } = host(async () => ({ ok: true, ref: 'asset:1' }))
  expect(input().accept.split(',')).toEqual([...UPLOADABLE_IMAGE_TYPES])
})

it('refuses an unsupported pick by name, naming the supported types, and stores nothing', async () => {
  const { input, notice, onAddImage, latest } = host(async () => ({ ok: true, ref: 'asset:1' }))

  fireEvent.change(input(), { target: { files: [avif()] } })

  await vi.waitFor(() => expect(notice()?.textContent).toContain('image/avif'))
  expect(notice()?.textContent).toContain('PNG')
  expect(onAddImage).not.toHaveBeenCalled()
  expect(latest.canvas.nodes).toHaveLength(0)
})

it('refuses an unsupported drop aloud rather than ignoring it', async () => {
  const { container, notice, onAddImage } = host(async () => ({ ok: true, ref: 'asset:1' }))
  const dataTransfer = new DataTransfer()
  dataTransfer.items.add(avif())

  rootOf(container).dispatchEvent(
    new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }),
  )

  await vi.waitFor(() => expect(notice()?.textContent).toContain('image/avif'))
  expect(onAddImage).not.toHaveBeenCalled()
})

it('refuses an unsupported paste aloud', async () => {
  const { container, notice, onAddImage } = host(async () => ({ ok: true, ref: 'asset:1' }))
  const clipboardData = new DataTransfer()
  clipboardData.items.add(avif())

  rootOf(container).dispatchEvent(
    new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
  )

  await vi.waitFor(() => expect(notice()?.textContent).toContain('image/avif'))
  expect(onAddImage).not.toHaveBeenCalled()
})

it('reports a refusal the host reports, and creates no node for it', async () => {
  const { input, notice, latest } = host(async () => ({
    ok: false,
    reason: "That image is over the daemon's 16 MiB limit.",
  }))

  fireEvent.change(input(), { target: { files: [png()] } })

  await vi.waitFor(() => expect(notice()?.textContent).toContain('16 MiB'))
  expect(latest.canvas.nodes).toHaveLength(0)
})

it('clears the notice when the next image is stored', async () => {
  let refuse = true
  const { input, notice, latest } = host(async () =>
    refuse ? { ok: false, reason: 'Nope.' } : { ok: true, ref: 'asset:1' },
  )
  fireEvent.change(input(), { target: { files: [png()] } })
  await vi.waitFor(() => expect(notice()?.textContent).toBe('Nope.'))

  refuse = false
  fireEvent.change(input(), { target: { files: [png()] } })

  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(1))
  expect(notice()?.textContent ?? '').toBe('')
})
