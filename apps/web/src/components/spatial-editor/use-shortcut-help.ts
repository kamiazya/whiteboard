// The shortcut sheet's open state, and the one key that opens it. The sheet is
// opened from the dock's button AND from `?` on the canvas, so its state lives
// above both; the key is matched through the catalog (`show-shortcuts`) in
// front of the editor's own keydown handler, which knows nothing of the sheet.
import { type KeyboardEvent, useState } from 'react'
import type { EditorTool } from '../../lib/editor-tool.js'
import { findShortcut } from './shortcuts.js'

export interface ShortcutHelpControl {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

export function useShortcutHelp(
  tool: EditorTool,
  handleKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void,
) {
  const [open, onOpenChange] = useState(false)
  const palette: ShortcutHelpControl = { open, onOpenChange }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (findShortcut(e.nativeEvent, tool)?.id === 'show-shortcuts') {
      e.preventDefault()
      onOpenChange(true)
      return
    }
    handleKeyDown(e)
  }
  return { palette, onKeyDown }
}
