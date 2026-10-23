// The slice of the keyboard hook a browser test cannot reach: Enter on a
// group edits its label through a seam the host supplies.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { renderHook } from '@testing-library/react'
import type { KeyboardEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createIdleState } from './gestures.js'
import { type EditorKeyboardInputs, useEditorKeyboard } from './use-editor-keyboard.js'

function setup(canvas: SpatialCanvas, selectedId: string, withSeam: boolean) {
  const setGroupLabelEditId = vi.fn()
  const root = document.createElement('div')
  const selectedNode = canvas.nodes.find((n) => n.id === selectedId)
  const inputs = {
    tool: 'select',
    canvas,
    canvasRef: { current: canvas },
    gestureState: createIdleState(),
    selection: { id: selectedId, box: { x: 0, y: 0, width: 1, height: 1 } },
    selectedNode,
    extraIds: new Set<string>(),
    selectedInkIds: [],
    setSelectedInkIds: vi.fn(),
    setSelectedEdgeId: vi.fn(),
    pendingCut: null,
    setPendingCut: vi.fn(),
    spaceDownRef: { current: false },
    isLocked: () => false,
    isEdgeLocked: () => false,
    applyResult: vi.fn(),
    applySelection: vi.fn(),
    ...(withSeam ? { setGroupLabelEditId } : {}),
  } as unknown as EditorKeyboardInputs
  const { result } = renderHook(() => useEditorKeyboard(inputs))
  const press = (key: string) => {
    const nativeEvent = new KeyboardEvent('keydown', { key, code: key })
    const preventDefault = vi.fn()
    result.current.handleKeyDown({
      nativeEvent,
      key,
      target: root,
      currentTarget: root,
      shiftKey: false,
      preventDefault,
    } as unknown as KeyboardEvent<HTMLDivElement>)
    return preventDefault
  }
  return { press, setGroupLabelEditId, inputs }
}

const board: SpatialCanvas = {
  nodes: [
    groupNode({ id: 'g', x: 0, y: 0, width: 300, height: 200 }),
    textNode({ id: 't', x: 400, y: 0, width: 100, height: 50, text: 'T' }),
  ],
  edges: [],
}

describe('Enter on a selected group', () => {
  it('opens the group label editor', () => {
    const { press, setGroupLabelEditId } = setup(board, 'g', true)
    const prevented = press('Enter')
    expect(setGroupLabelEditId).toHaveBeenCalledWith('g')
    expect(prevented).toHaveBeenCalled()
  })

  it('is left alone when the host supplies no label editor', () => {
    const { press } = setup(board, 'g', false)
    expect(press('Enter')).not.toHaveBeenCalled()
  })
})
