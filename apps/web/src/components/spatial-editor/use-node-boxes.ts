// The pre-scene node-geometry memos, extracted from SpatialEditor: every
// node's box, and the selected node's box/value. Computed straight off the
// `canvas` prop — before layout runs — so useViewportControls (which frames
// on `boxes`) never waits on the worker-laid-out scene.

import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { useMemo } from 'react'
import { type Box, indexNodeBoxes, type NodeBox } from './geometry.js'

export interface NodeBoxesInputs {
  readonly canvas: SpatialCanvas
  readonly selectedId: string | null
}

export function useNodeBoxes({ canvas, selectedId }: NodeBoxesInputs): {
  readonly boxes: readonly NodeBox[]
  readonly selectedBox: Box | undefined
  readonly selectedNode: SpatialNode | undefined
} {
  const boxes = useMemo(() => indexNodeBoxes(canvas), [canvas])
  const selectedBox = useMemo(
    () => (selectedId === null ? undefined : boxes.find((b) => b.id === selectedId)?.box),
    [boxes, selectedId],
  )
  const selectedNode = useMemo(
    () => (selectedId === null ? undefined : canvas.nodes.find((n) => n.id === selectedId)),
    [canvas, selectedId],
  )
  return { boxes, selectedBox, selectedNode }
}
