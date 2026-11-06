import type { EditorTool } from '../../lib/editor-tool.js'
import { connectToolHint } from './ConnectToolHint.js'

/** What a screen reader hears when a tool is armed, in the words the dock and the catalog use. */
const TOOL_ANNOUNCEMENT = {
  select: 'Select tool',
  hand: 'Hand tool',
  connect: 'Connect tool',
  draw: 'Draw tool',
  erase: 'Eraser',
} as const satisfies Record<EditorTool, string>

/**
 * What arming `tool` says aloud. Connect adds its two-press instruction where
 * the canvas shows it — on a board with notes to join — so it is heard once.
 */
export function toolAnnouncement(tool: EditorTool, hasNodes: boolean, coarse: boolean): string {
  return tool === 'connect' && hasNodes
    ? `${TOOL_ANNOUNCEMENT.connect}. ${connectToolHint(coarse)}`
    : TOOL_ANNOUNCEMENT[tool]
}
