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
    const { result } = renderHook(() => useNodeInEditor(canvas, onChange))
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
    const { result } = renderHook(() => useNodeInEditor(canvas, onChange))
    act(() => result.current.open('n1', 'before'))
    act(() => result.current.commit('before'))
    expect(onChange).not.toHaveBeenCalled()
  })

  // A commit can only arrive from the open surface, but a closed hook must
  // not write on the strength of a stale callback either.
  it('writes nothing when nothing is open', () => {
    const onChange = vi.fn()
    const { result } = renderHook(() => useNodeInEditor(canvas, onChange))
    act(() => result.current.commit('after'))
    expect(onChange).not.toHaveBeenCalled()
  })
})
