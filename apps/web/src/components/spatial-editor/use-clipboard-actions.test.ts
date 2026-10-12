// The clipboard hook's picture half, outside a browser: a copy stamps where
// its pictures live, a paste from the same scope lands at once with its
// references untouched, and a paste from another scope stores the carried
// bytes first, lands pointed at the new references, and says which pictures
// did not come along. The real-browser flow is clipboard-images.browser.test.tsx.
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { nodeFile } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { MutableRefObject } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClipboardImageSeams, PastedFragment } from '../../lib/clipboard-images.js'
import { clearClipboardFragmentForTests, readClipboardFragment } from '../../lib/clipboard-store.js'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import { type ClipboardActionsInputs, useClipboardActions } from './use-clipboard-actions.js'

const EMPTY: SpatialCanvas = { nodes: [], edges: [] }

const picture = (id: string, file: string): SpatialNode =>
  fileNode({ id, x: 0, y: 0, width: 40, height: 40, file })

function seams(overrides: Partial<ClipboardImageSeams> = {}): ClipboardImageSeams {
  return {
    fileScope: 'target-scope',
    readImage: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    storeImage: async (file) => ({ ok: true, ref: `asset:stored-${file.name}` }),
    ...overrides,
  }
}

function harness(canvas: SpatialCanvas, overrides: Partial<ClipboardActionsInputs> = {}) {
  const canvasRef: MutableRefObject<SpatialCanvas> = { current: canvas }
  const changes: Array<{ next: SpatialCanvas; command: EditorCommand }> = []
  const selectNodes = vi.fn()
  let ids = 0
  const inputs: ClipboardActionsInputs = {
    canvasRef,
    primaryId: undefined,
    extraIds: [],
    selectedInkIds: [],
    pendingCut: null,
    setPendingCut: vi.fn(),
    onChange: (next, command) => {
      canvasRef.current = next
      changes.push({ next, command })
    },
    createId: () => `new-${++ids}`,
    clipboardImages: seams(),
    selectNodes,
    selectInk: vi.fn(),
    viewport: { x: 0, y: 0, zoom: 1 },
    viewportCenterScreen: () => ({ x: 0, y: 0 }),
    ...overrides,
  }
  const hook = renderHook(() => useClipboardActions(inputs))
  return { hook, changes, selectNodes, canvasRef }
}

const pastedFiles = (canvas: SpatialCanvas) => canvas.nodes.map((node) => nodeFile(node))

beforeEach(clearClipboardFragmentForTests)

describe('useClipboardActions, pictures across a paste', () => {
  it('stamps a copy with the scope its pictures live in', () => {
    const { hook } = harness({ nodes: [picture('p', 'asset:a')], edges: [] }, { primaryId: 'p' })
    const copied = hook.result.current.copySelection()
    expect(copied?.source?.fileScope).toBe('target-scope')
    expect(readClipboardFragment()).toBe(copied)
  })

  it('lands a paste from the same scope at once, its references as they were', () => {
    const storeImage = vi.fn()
    const { hook, changes } = harness(EMPTY, { clipboardImages: seams({ storeImage }) })
    const fragment: PastedFragment = {
      nodes: [picture('p', 'asset:a')],
      edges: [],
      source: { fileScope: 'target-scope', copyId: 'c1' },
    }
    let handled = false
    act(() => {
      handled = hook.result.current.pasteFragment(fragment)
    })
    expect(handled).toBe(true)
    expect(changes).toHaveLength(1)
    expect(pastedFiles(changes[0]?.next ?? EMPTY)).toEqual(['asset:a'])
    expect(storeImage).not.toHaveBeenCalled()
  })

  it('stores carried pictures from another scope, then lands them under the new references', async () => {
    const storeImage = vi.fn(async (file: File) => ({
      ok: true as const,
      ref: `asset:stored-${file.name}`,
    }))
    const { hook, changes, selectNodes } = harness(EMPTY, {
      clipboardImages: seams({ storeImage }),
    })
    const fragment: PastedFragment = {
      nodes: [picture('p', 'asset:a')],
      edges: [],
      source: { fileScope: 'other-scope', copyId: 'c1' },
      files: { 'asset:a': { mimeType: 'image/png', dataBase64: btoa('png') } },
    }
    let handled = false
    act(() => {
      handled = hook.result.current.pasteFragment(fragment)
    })
    // HANDLED at once, but nothing lands until the bytes are stored.
    expect(handled).toBe(true)
    expect(changes).toHaveLength(0)

    await waitFor(() => expect(changes).toHaveLength(1))
    expect(storeImage).toHaveBeenCalledTimes(1)
    expect(pastedFiles(changes[0]?.next ?? EMPTY)).toEqual(['asset:stored-a'])
    expect(selectNodes).toHaveBeenCalledWith([changes[0]?.next.nodes[0]?.id])
    expect(hook.result.current.clipboardNotice.text).toBeNull()
  })

  it('leaves out a picture whose bytes did not come along, and says so', async () => {
    const { hook, changes } = harness(EMPTY)
    const fragment: PastedFragment = {
      nodes: [picture('kept', 'asset:a'), picture('lost', 'asset:b')],
      edges: [],
      source: { fileScope: 'other-scope', copyId: 'c1' },
      files: { 'asset:a': { mimeType: 'image/png', dataBase64: btoa('png') } },
    }
    act(() => {
      hook.result.current.pasteFragment(fragment)
    })
    await waitFor(() => expect(changes).toHaveLength(1))
    expect(pastedFiles(changes[0]?.next ?? EMPTY)).toEqual(['asset:stored-a'])
    await waitFor(() =>
      expect(hook.result.current.clipboardNotice.text).toMatch(/A picture was left out/),
    )
  })

  it('writes nothing when the editor unmounts while the pictures are stored', async () => {
    let release: (value: { ok: true; ref: string }) => void = () => {}
    const storeImage = vi.fn(
      () =>
        new Promise<{ ok: true; ref: string }>((resolve) => {
          release = resolve
        }),
    )
    const { hook, changes } = harness(EMPTY, { clipboardImages: seams({ storeImage }) })
    act(() => {
      hook.result.current.pasteFragment({
        nodes: [picture('p', 'asset:a')],
        edges: [],
        source: { fileScope: 'other-scope', copyId: 'c1' },
        files: { 'asset:a': { mimeType: 'image/png', dataBase64: btoa('png') } },
      })
    })
    await waitFor(() => expect(storeImage).toHaveBeenCalledTimes(1))
    hook.unmount()
    release({ ok: true, ref: 'asset:late' })
    // A macrotask drains the transfer's continuation.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(changes).toHaveLength(0)
  })
})

describe('useClipboardActions, a cut pasted as a copy', () => {
  const box = (id: string, x: number) => textNode({ id, x, y: 0, width: 40, height: 40, text: id })
  const wired: SpatialCanvas = {
    nodes: [box('a', 0), box('b', 100)],
    edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' } }],
  }
  const edgesOntoPeer = (command: EditorCommand | undefined) =>
    command?.kind === 'batch'
      ? command.commands.filter((c) => c.kind === 'create-edge' && c.edge.to.node === 'b')
      : []

  it('reconnects to the surviving peer once, and pastes as a plain copy while that wire stands', () => {
    const { hook, changes, canvasRef } = harness(wired, {
      primaryId: 'a',
      clipboardImages: undefined,
    })
    const cut = hook.result.current.cutSelection()
    if (cut === null) throw new Error('expected a cut fragment')
    expect(cut.cut).toBeDefined()
    // The hold resolved as a delete: the original and its wire are gone.
    canvasRef.current = { nodes: [box('b', 100)], edges: [] }

    act(() => {
      hook.result.current.pasteFragment(cut)
    })
    expect(edgesOntoPeer(changes[0]?.command)).toHaveLength(1)

    act(() => {
      hook.result.current.pasteFragment(cut)
    })
    expect(changes).toHaveLength(2)
    expect(edgesOntoPeer(changes[1]?.command)).toHaveLength(0)
  })

  it('answers unhandled for a fragment that makes nothing', () => {
    const { hook, changes } = harness(EMPTY)
    let handled = true
    act(() => {
      handled = hook.result.current.pasteFragment({ nodes: [], edges: [] })
    })
    expect(handled).toBe(false)
    expect(changes).toHaveLength(0)
  })
})
