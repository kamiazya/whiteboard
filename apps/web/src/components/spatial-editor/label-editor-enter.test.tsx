/**
 * A connection's label is one line, as a frame's name is: a bare Enter keeps
 * it, and the strip and the description under the field say so. A label
 * editor that took Enter as a line break scrolled the typed text out of its
 * one-line box, and the Escape that followed threw it away.
 */

import { resolveCanvasPalette } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EdgeLabelEditorOverlay, GroupLabelEditorOverlay } from './label-editor-overlays.js'

afterEach(cleanup)

const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 100, height: 60, text: 'A' }),
    textNode({ id: 'b', x: 300, y: 0, width: 100, height: 60, text: 'B' }),
    groupNode({ id: 'g', x: 0, y: 200, width: 400, height: 200, label: 'Tier' }),
  ],
  edges: [{ id: 'e', from: { node: 'a' }, to: { node: 'b' } }],
}

const edgePaths = [
  {
    id: 'e',
    path: [
      { x: 100, y: 30 },
      { x: 300, y: 30 },
    ],
  },
]

function renderEdgeEditor() {
  const applyResult = vi.fn()
  const onClose = vi.fn()
  render(
    <EdgeLabelEditorOverlay
      editId="e"
      canvas={canvas}
      fontFamily="sans-serif"
      edgePaths={edgePaths}
      sceneNodes={[]}
      zoom={1}
      palette={resolveCanvasPalette(canvas, 'light')}
      applyResult={applyResult}
      onClose={onClose}
    />,
  )
  return { applyResult, onClose, field: screen.getByTestId('edge-label-editor') }
}

describe('connection label editor', () => {
  it('keeps the label on a bare Enter', () => {
    const { applyResult, onClose, field } = renderEdgeEditor()
    fireEvent.change(field, { target: { value: 'depends on' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(applyResult).toHaveBeenCalledTimes(1)
    expect(applyResult.mock.calls[0]?.[0].commands).toEqual([
      expect.objectContaining({ kind: 'set-edge-label', label: 'depends on' }),
    ])
    expect(onClose).toHaveBeenCalled()
  })

  it('names a bare Enter as the way to keep it', () => {
    const { field } = renderEdgeEditor()
    expect(screen.getByTestId('editor-exit-hint').textContent).toMatch(/^↩Done/)
    const describedBy = field.getAttribute('aria-describedby') ?? ''
    expect(document.getElementById(describedBy)?.textContent).toBe('Escape discards, Enter keeps')
    expect(field.getAttribute('aria-keyshortcuts')).toBe('Enter')
  })
})

it('a frame name names a bare Enter as the way to keep it', () => {
  render(
    <GroupLabelEditorOverlay
      editId="g"
      canvas={canvas}
      fontFamily="sans-serif"
      zoom={1}
      palette={resolveCanvasPalette(canvas, 'light')}
      applyResult={vi.fn()}
      onClose={vi.fn()}
    />,
  )
  expect(screen.getByTestId('editor-exit-hint').textContent).toMatch(/^↩Done/)
})
