import { groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { expect, it } from 'vitest'
import { canvasRootLabel } from './keyboard-menu.js'

it('a canvas of frames alone says Tab reaches a frame, not a note', () => {
  const frames = [
    groupNode({ id: 'a', x: 0, y: 0, width: 300, height: 200, label: 'Went well' }),
    groupNode({ id: 'b', x: 340, y: 0, width: 300, height: 200, label: 'To improve' }),
  ]
  expect(canvasRootLabel({ nodes: frames, edges: [] }, null, null)).toBe(
    'Canvas, 2 frames. Tab selects the first frame',
  )
})

it('the first stop is named for what comes first in reading order', () => {
  const nodes = [
    textNode({ id: 'n', x: 40, y: 400, width: 200, height: 100, text: 'below' }),
    groupNode({ id: 'g', x: 0, y: 0, width: 300, height: 200, label: 'Top' }),
  ]
  expect(canvasRootLabel({ nodes, edges: [] }, null, null)).toBe(
    'Canvas, 1 note, 1 frame. Tab selects the first frame',
  )
})
