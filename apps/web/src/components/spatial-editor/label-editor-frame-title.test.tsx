/**
 * The inline edge-label editor opens where the drawn label would sit, and the
 * drawn label keeps off a frame's title; the editor has to keep off it too, or
 * the draft opens over the title and jumps when it commits.
 */

import { resolveCanvasPalette, type SceneNode } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EdgeLabelEditorOverlay } from './label-editor-overlays.js'

afterEach(cleanup)

const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'top', x: 60, y: -60, width: 100, height: 60, text: 'top' }),
    groupNode({ id: 'tier', x: 0, y: 100, width: 400, height: 200, label: 'Presentation tier' }),
    textNode({ id: 'inner', x: 60, y: 160, width: 100, height: 60, text: 'inner' }),
  ],
  edges: [{ id: 'down', from: { node: 'top' }, to: { node: 'inner' } }],
}

// A straight drop through the gap above the frame, whose midpoint (110, 80)
// lies on the title's row.
const edgePaths = [
  {
    id: 'down',
    path: [
      { x: 110, y: 0 },
      { x: 110, y: 160 },
    ],
  },
]

const title = {
  kind: 'textRun' as const,
  text: 'Presentation tier',
  bbox: { x: 90, y: 68, w: 60, h: 14 },
  annotates: { kind: 'node' as const, id: 'tier' },
}

function editorBox(sceneNodes: readonly SceneNode[]) {
  render(
    <EdgeLabelEditorOverlay
      editId="down"
      canvas={canvas}
      fontFamily="sans-serif"
      edgePaths={edgePaths}
      sceneNodes={sceneNodes}
      zoom={1}
      palette={resolveCanvasPalette(canvas, 'light')}
      applyResult={vi.fn()}
      onClose={vi.fn()}
    />,
  )
  const style = screen.getByTestId('edge-label-editor').style
  return { x: Number.parseFloat(style.left), y: Number.parseFloat(style.top) }
}

const overlapsTitle = (box: { x: number; y: number }) =>
  box.x < title.bbox.x + title.bbox.w &&
  title.bbox.x < box.x + 160 &&
  box.y < title.bbox.y + title.bbox.h &&
  title.bbox.y < box.y + 28

it('opens off the frame title the drawn label would also avoid', () => {
  expect(overlapsTitle(editorBox([title]))).toBe(false)
})

it('opens at the line midpoint when no title is in the way', () => {
  expect(editorBox([])).toEqual({ x: 30, y: 66 })
})
