import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { readUnsavedNotes } from '../../lib/spatial/unsaved-notes.js'
import type { GestureState } from './gestures.js'
import { useRemoveAbandonedNote } from './use-abandoned-note.js'

afterEach(() => sessionStorage.clear())

const empty = textNode({ id: 'n', x: 0, y: 0, width: 200, height: 100, text: '' })
const typed = textNode({ id: 't', x: 300, y: 0, width: 200, height: 100, text: 'kept' })
const editingNew: GestureState = {
  kind: 'editing-text',
  nodeId: 'n',
  pendingText: '',
  createdForEdit: true,
}

function mount(canvas: SpatialCanvas, gestureState: GestureState) {
  const onChange = vi.fn()
  const view = renderHook(
    (props: { canvas: SpatialCanvas; gestureState: GestureState }) =>
      useRemoveAbandonedNote({
        gestureState: props.gestureState,
        gestureStateRef: { current: props.gestureState },
        canvas: props.canvas,
        canvasRef: { current: props.canvas },
        onChange,
        documentKey: 'doc',
      }),
    { initialProps: { canvas, gestureState } },
  )
  return { ...view, onChange }
}

it('a note made for an edit is remembered until the edit ends', () => {
  const canvas = { nodes: [empty], edges: [] }
  const { rerender } = mount(canvas, editingNew)
  expect(readUnsavedNotes('doc')).toEqual(['n'])

  rerender({ canvas, gestureState: { kind: 'idle' } })
  expect(readUnsavedNotes('doc')).toEqual([])
})

it('a note the last page left mid-edit, still empty, is removed on the next load', () => {
  sessionStorage.setItem('wb.unsaved-notes:doc', JSON.stringify(['n', 't']))
  const { onChange } = mount({ nodes: [empty, typed], edges: [] }, { kind: 'idle' })

  expect(onChange).toHaveBeenCalledTimes(1)
  const [next, command] = onChange.mock.calls[0] as [SpatialCanvas, unknown]
  expect(command).toEqual({ kind: 'delete-node', id: 'n' })
  expect(next.nodes.map((node) => node.id)).toEqual(['t'])
  expect(readUnsavedNotes('doc')).toEqual([])
})

it('a remembered note not on the canvas yet is kept for when it arrives', () => {
  sessionStorage.setItem('wb.unsaved-notes:doc', JSON.stringify(['n']))
  const { onChange, rerender } = mount({ nodes: [], edges: [] }, { kind: 'idle' })
  expect(onChange).not.toHaveBeenCalled()

  rerender({ canvas: { nodes: [empty], edges: [] }, gestureState: { kind: 'idle' } })
  expect(onChange).toHaveBeenCalledWith(expect.anything(), { kind: 'delete-node', id: 'n' })
})
