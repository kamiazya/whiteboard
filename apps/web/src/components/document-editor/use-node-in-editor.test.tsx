import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useNodeInEditor } from './use-node-in-editor.js'

const canvas: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'before' }],
  edges: [],
}

describe('useNodeInEditor', () => {
  it('opens on a node, writes the edit, and closes', () => {
    const onChange = vi.fn()
    const { result } = renderHook(() => useNodeInEditor(canvas, onChange, 'doc-a'))
    expect(result.current.editing).toBeNull()

    act(() => result.current.open('n1', 'before'))
    expect(result.current.editing).toEqual({ id: 'n1', text: 'before' })

    act(() => result.current.commit('after'))
    const [next, command] = onChange.mock.calls[0] ?? []
    expect((next as SpatialCanvas).nodes[0]).toMatchObject({ id: 'n1', text: 'after' })
    expect(command).toEqual({ kind: 'set-text', id: 'n1', text: 'after' })

    act(() => result.current.close())
    expect(result.current.editing).toBeNull()
  })

  it('writes nothing when the edit changes nothing', () => {
    const onChange = vi.fn()
    const { result } = renderHook(() => useNodeInEditor(canvas, onChange, 'doc-a'))
    act(() => result.current.open('n1', 'before'))
    act(() => result.current.commit('before'))
    expect(onChange).not.toHaveBeenCalled()
  })

  // A commit can only arrive from the open surface, but a closed hook must
  // not write on the strength of a stale callback either.
  it('writes nothing when nothing is open', () => {
    const onChange = vi.fn()
    const { result } = renderHook(() => useNodeInEditor(canvas, onChange, 'doc-a'))
    act(() => result.current.commit('after'))
    expect(onChange).not.toHaveBeenCalled()
  })
  /**
   * The surface is opened against a node, and the node belongs to one
   * document. Both pages that mount it keep their own document switching —
   * `BrowserDocumentPage` says so at its mount site — so an edit left open
   * has to be dropped when the document under it changes.
   *
   * Left standing it is worse than stale. The overlay is full-screen and
   * takes its title from the CURRENT document, so it reads as "Editing
   * <the document you just arrived at>" while holding the other one's node.
   * And `commit` resolves the node in the CURRENT canvas: `withNodeText`
   * returns the same canvas for a node it cannot find, and the caller drops
   * a no-op write — so everything typed into it after the switch is
   * discarded with no error and no indication.
   */
  it('drops an open edit when the document under it changes', () => {
    const onChange = vi.fn()
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useNodeInEditor(canvas, onChange, id),
      { initialProps: { id: 'doc-a' } },
    )
    act(() => result.current.open('n1', 'before'))
    expect(result.current.editing).not.toBeNull()

    rerender({ id: 'doc-b' })
    expect(
      result.current.editing,
      'the editor is still open over a document that does not hold this node, and anything typed into it now is discarded on commit',
    ).toBeNull()
  })

  it('leaves an open edit alone while the document stays the same', () => {
    const onChange = vi.fn()
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useNodeInEditor(canvas, onChange, id),
      { initialProps: { id: 'doc-a' } },
    )
    act(() => result.current.open('n1', 'before'))
    rerender({ id: 'doc-a' })
    expect(
      result.current.editing,
      'a re-render that did not change the document must not close the surface under the caret',
    ).toEqual({ id: 'n1', text: 'before' })
  })
})
