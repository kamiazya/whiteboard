// The tool/mode state, extracted from SpatialEditor: which OOUI mode is
// armed, the initial-tool-once effect, the context menu, the long-press
// pulse, and the ref the long-press timer calls through to open that menu
// with the LATEST render's closure.

import { useEffect, useRef, useState } from 'react'
import type { ContextMenuTarget } from './CanvasContextMenu.js'
import type { EditorTool } from './ToolPalette.js'
import type { Point } from './viewport.js'

export interface ToolStateInputs {
  readonly defaultTool: EditorTool
  readonly initialTool: EditorTool | undefined
}

export function useToolState({ defaultTool, initialTool }: ToolStateInputs) {
  // OOUI interaction mode (S6/S7): Hand (navigation) is the default —
  // Select restores the pre-tool editing behavior byte-for-byte; Connect
  // arms object-first click-A, click-B edge creation. Creation is
  // deliberately NOT a mode — the palette's Note entry works in every mode.
  const [tool, setTool] = useState<EditorTool>(defaultTool)
  const toolChosenByUserRef = useRef(false)
  const initialToolAppliedRef = useRef(false)
  useEffect(() => {
    if (initialTool === undefined) return
    if (initialToolAppliedRef.current || toolChosenByUserRef.current) return
    initialToolAppliedRef.current = true
    setTool(initialTool)
  }, [initialTool])
  const [contextMenu, setContextMenu] = useState<ContextMenuTarget | null>(null)
  // Screen point of the last committed long-press, while its pulse plays.
  const [longPressPulse, setLongPressPulse] = useState<Point | null>(null)
  // The timer must call the LATEST render's opener (fresh viewport/boxes/
  // selection), not the one captured when the finger landed.
  const openContextMenuAtRef = useRef<(screen: Point) => void>(() => {})

  return {
    tool,
    setTool,
    toolChosenByUserRef,
    contextMenu,
    setContextMenu,
    longPressPulse,
    setLongPressPulse,
    openContextMenuAtRef,
  }
}
