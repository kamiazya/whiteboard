// The tool the eraser was picked up from, so putting it down returns there.

import { useRef } from 'react'
import type { EditorTool } from '../../lib/editor-tool.js'

/**
 * The last tool armed that was not the eraser. The eraser is a brief detour
 * from whatever someone was doing — most often drawing — and Escape landing
 * them in Select instead made every correction cost a second key to get the
 * pen back. Starts at Select, which is where a canvas opens.
 */
export function useToolBeforeEraser(tool: EditorTool): EditorTool {
  const before = useRef<EditorTool>('select')
  if (tool !== 'erase') before.current = tool
  return before.current
}
