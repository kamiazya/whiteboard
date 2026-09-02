// The empty-canvas branch's composition rules: paste only with a clipboard
// fragment, creation entries always, document/image only when the host wires
// them, Tidy only once there is a second node to tidy against.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearClipboardFragmentForTests,
  writeClipboardFragment,
} from '../../../lib/clipboard-store.js'
import { canvasMenuItems } from './canvas-menu-items.js'

const emptyCanvas: SpatialCanvas = { nodes: [], edges: [] }
const twoNodeCanvas: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'a' },
    { id: 'b', type: 'text', x: 20, y: 0, width: 10, height: 10, text: 'b' },
  ],
  edges: [],
}

function baseInput(canvas: SpatialCanvas) {
  return {
    point: { x: 5, y: 5 },
    canvas,
    canvasRef: { current: canvas },
    isLocked: () => false,
    fileRefOptions: undefined,
    onAddImage: undefined,
    pendingImagePointRef: { current: null },
    imageInputRef: { current: null },
    pasteClipboard: vi.fn(),
    createNodeAt: vi.fn(),
    setLinkDialog: vi.fn(),
    createGroupAtViewportCenter: vi.fn(),
    setDocumentPicker: vi.fn(),
    applyBoxMoves: vi.fn(),
    setCommentCompose: vi.fn(),
  }
}

describe('canvasMenuItems', () => {
  afterEach(() => {
    clearClipboardFragmentForTests()
  })

  it('offers the creation entries, then a comment band, when nothing extra is wired', () => {
    const items = canvasMenuItems(baseInput(emptyCanvas))
    expect(items.map((item) => (item as { label?: string }).label ?? item.kind)).toEqual([
      'Note',
      'Link',
      'Group',
      'separator',
      'Comment here',
    ])
  })

  it('"Comment here" opens a compose anchored at the click point, about no node', () => {
    const input = baseInput(emptyCanvas)
    const items = canvasMenuItems(input)
    const item = items.find((entry) => (entry as { label?: string }).label === 'Comment here')
    ;(item as { onSelect: () => void }).onSelect()
    expect(input.setCommentCompose).toHaveBeenCalledWith({ point: { x: 5, y: 5 } })
  })

  it('prepends Paste here (and a separator) only when a clipboard fragment exists', () => {
    const withoutFragment = canvasMenuItems(baseInput(emptyCanvas))
    expect(
      withoutFragment.some((item) => (item as { label?: string }).label === 'Paste here'),
    ).toBe(false)

    writeClipboardFragment({
      type: 'whiteboard/clipboard',
      version: 1,
      nodes: [{ id: 'n', type: 'text', x: 0, y: 0, width: 1, height: 1, text: '' }],
      edges: [],
    })
    const withFragment = canvasMenuItems(baseInput(emptyCanvas))
    expect(withFragment[0]).toMatchObject({ label: 'Paste here' })
    expect(withFragment[1]).toEqual({ kind: 'separator' })

    const pasteClipboard = vi.fn()
    const input = { ...baseInput(emptyCanvas), pasteClipboard }
    const items = canvasMenuItems(input)
    ;(items[0] as { onSelect: () => void }).onSelect()
    expect(pasteClipboard).toHaveBeenCalledWith({ x: 5, y: 5 })
  })

  it('adds Document only when fileRefOptions is wired', () => {
    const without = canvasMenuItems(baseInput(emptyCanvas))
    expect(without.some((item) => (item as { label?: string }).label === 'Document')).toBe(false)

    const withDocument = canvasMenuItems({ ...baseInput(emptyCanvas), fileRefOptions: [] })
    expect(withDocument.some((item) => (item as { label?: string }).label === 'Document')).toBe(
      true,
    )
  })

  it('adds Image only when onAddImage is wired', () => {
    const without = canvasMenuItems(baseInput(emptyCanvas))
    expect(without.some((item) => (item as { label?: string }).label === 'Image')).toBe(false)

    const withImage = canvasMenuItems({ ...baseInput(emptyCanvas), onAddImage: vi.fn() })
    expect(withImage.some((item) => (item as { label?: string }).label === 'Image')).toBe(true)
  })

  it('adds a separator + Tidy canvas only once the canvas holds a second node', () => {
    const withOne = canvasMenuItems(baseInput(emptyCanvas))
    expect(withOne.some((item) => (item as { label?: string }).label === 'Tidy canvas')).toBe(false)

    const applyBoxMoves = vi.fn()
    const withTwo = canvasMenuItems({ ...baseInput(twoNodeCanvas), applyBoxMoves })
    const tidyIndex = withTwo.findIndex(
      (item) => (item as { label?: string }).label === 'Tidy canvas',
    )
    expect(tidyIndex).toBeGreaterThan(0)
    expect(withTwo[tidyIndex - 1]).toEqual({ kind: 'separator' })
    ;(withTwo[tidyIndex] as { onSelect: () => void }).onSelect()
    expect(applyBoxMoves).toHaveBeenCalled()
  })
})
