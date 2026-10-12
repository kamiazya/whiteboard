// A copied picture keeps its picture wherever it is pasted. Where a picture's
// bytes live is per keeper — the daemon keeps them per workspace — so a paste
// into another scope stores the carried bytes through the TARGET's image seam
// and remints the reference, and a paste whose bytes did not come along says so
// instead of pasting a reference nothing resolves.

import { nodeFile, type SpatialCanvas, type SpatialNode } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ClipboardImageSeams } from '../../lib/clipboard-images.js'
import { clearClipboardFragmentForTests } from '../../lib/clipboard-store.js'
import { makeEditorHost } from '../../test-utils/spatial-editor-host.js'
import { rootOf } from '../../test-utils/spatial-editor-root.js'

afterEach(cleanup)
beforeEach(clearClipboardFragmentForTests)

const PICTURE_BYTES = new Uint8Array([137, 80, 78, 71, 1, 2, 3])

const source: SpatialCanvas = {
  nodes: [fileNode({ id: 'img', x: 40, y: 40, width: 160, height: 80, file: 'asset:src' })],
  edges: [],
}

/** A keeper's picture seams over an in-memory store, recording what it was asked to store. */
function keeper(fileScope: string, held: Record<string, Uint8Array<ArrayBuffer>> = {}) {
  const stored: File[] = []
  const seams: ClipboardImageSeams = {
    fileScope,
    readImage: async (ref) => {
      const bytes = held[ref]
      return bytes === undefined ? undefined : new Blob([bytes], { type: 'image/png' })
    },
    storeImage: vi.fn(async (file: File) => {
      stored.push(file)
      return { ok: true as const, ref: `asset:minted-${stored.length}` }
    }),
  }
  return { seams, stored }
}

function selectFirst(root: HTMLElement) {
  const r = root.getBoundingClientRect()
  fireEvent.pointerDown(root, {
    button: 0,
    pointerId: 1,
    clientX: r.left + 120,
    clientY: r.top + 80,
  })
  fireEvent.pointerUp(root, { pointerId: 1, clientX: r.left + 120, clientY: r.top + 80 })
}

function clipboardEvent(root: HTMLElement, type: 'copy' | 'paste', data: DataTransfer) {
  fireEvent(
    root,
    new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: data }),
  )
}

/** Copies the picture node under `seams`, answering the clipboard text the copy event wrote. */
function copyUnder(seams: ClipboardImageSeams): string {
  const { Host } = makeEditorHost({ initial: source, editorProps: { clipboardImages: seams } })
  const { container, unmount } = render(<Host />)
  const root = rootOf(container)
  selectFirst(root)
  const data = new DataTransfer()
  clipboardEvent(root, 'copy', data)
  unmount()
  return data.getData('text/plain')
}

function pasteUnder(seams: ClipboardImageSeams, text: string) {
  const host = makeEditorHost({
    initial: { nodes: [], edges: [] },
    editorProps: { clipboardImages: seams },
  })
  const { container } = render(<host.Host />)
  const data = new DataTransfer()
  data.setData('text/plain', text)
  clipboardEvent(rootOf(container), 'paste', data)
  return { latest: host.latest, container }
}

const pastedFile = (canvas: SpatialCanvas) => nodeFile(canvas.nodes[0] as SpatialNode)

it('a paste into another workspace stores the picture there and points at the copy', async () => {
  const from = keeper('daemon:a', { 'asset:src': PICTURE_BYTES })
  const to = keeper('daemon:b')
  const { latest } = pasteUnder(to.seams, copyUnder(from.seams))

  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(1))
  expect(to.stored).toHaveLength(1)
  expect(new Uint8Array(await (to.stored[0] as File).arrayBuffer())).toEqual(PICTURE_BYTES)
  expect(to.stored[0]?.type).toBe('image/png')
  expect(pastedFile(latest.canvas)).toBe('asset:minted-1')
})

it('a fragment from another tab carries its picture bytes inline', async () => {
  const fragment = {
    type: 'whiteboard/clipboard',
    version: 1,
    nodes: source.nodes,
    edges: [],
    source: { fileScope: 'daemon:a', copyId: 'other-tab' },
    files: { 'asset:src': { mimeType: 'image/png', dataBase64: btoa('\x89PNG') } },
  }
  const to = keeper('browser:x')
  const { latest } = pasteUnder(to.seams, JSON.stringify(fragment))

  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(1))
  expect(to.stored).toHaveLength(1)
  expect(pastedFile(latest.canvas)).toBe('asset:minted-1')
})

it('a paste into the same workspace keeps the reference and stores nothing', () => {
  const home = keeper('daemon:a', { 'asset:src': PICTURE_BYTES })
  const text = copyUnder(home.seams)
  const { latest } = pasteUnder(home.seams, text)

  expect(latest.canvas.nodes).toHaveLength(1)
  expect(pastedFile(latest.canvas)).toBe('asset:src')
  expect(home.seams.storeImage).not.toHaveBeenCalled()
})

it('a picture whose bytes did not come along is left out, and the paste says so', async () => {
  const fragment = {
    type: 'whiteboard/clipboard',
    version: 1,
    nodes: [
      ...source.nodes,
      textNode({ id: 't', x: 300, y: 40, width: 100, height: 50, text: 'caption' }),
    ],
    edges: [],
  }
  const to = keeper('daemon:b')
  const { latest, container } = pasteUnder(to.seams, JSON.stringify(fragment))

  await vi.waitFor(() => expect(latest.canvas.nodes).toHaveLength(1))
  expect(latest.canvas.nodes.some((node) => pastedFile({ nodes: [node], edges: [] }))).toBe(false)
  expect(to.seams.storeImage).not.toHaveBeenCalled()
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="clipboard-notice"]')?.textContent).toContain(
      'A picture was left out of the paste',
    ),
  )
})
