// The tool/mode state, extracted from SpatialEditor: which OOUI mode is
// armed, the context menu, the long-press pulse, and the ref the long-press
// timer calls through to open that menu with the LATEST render's closure.

import { useRef, useState } from 'react'
import type { EditorTool } from '../../lib/editor-tool.js'
import type { Point } from '../../lib/spatial/viewport.js'
import type { ContextMenuTarget } from './CanvasContextMenu.js'

export function useToolState(defaultTool: EditorTool) {
  // OOUI interaction mode: Select (editing) is the default, Hand is
  // navigation where a plain drag pans, Connect arms object-first click-A,
  // click-B edge creation. Creation is deliberately NOT a mode — the
  // palette's Note entry works in every mode.
  const [tool, setTool] = useState<EditorTool>(defaultTool)
  const [contextMenu, setContextMenu] = useState<ContextMenuTarget | null>(null)
  // Screen point of the last committed long-press, while its pulse plays.
  const [longPressPulse, setLongPressPulse] = useState<Point | null>(null)
  // The timer must call the LATEST render's opener (fresh viewport/boxes/
  // selection), not the one captured when the finger landed.
  const openContextMenuAtRef = useRef<(screen: Point) => void>(() => {})

  return {
    tool,
    setTool,
    contextMenu,
    setContextMenu,
    longPressPulse,
    setLongPressPulse,
    openContextMenuAtRef,
  }
}
