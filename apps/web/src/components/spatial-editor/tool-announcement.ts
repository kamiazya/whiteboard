import type { EditorTool } from '../../lib/editor-tool.js'

/** What a screen reader hears when a tool is armed, in the words the dock and the catalog use. */
export const TOOL_ANNOUNCEMENT = {
  select: 'Select tool',
  hand: 'Hand tool',
  connect: 'Connect tool',
  draw: 'Draw tool',
} as const satisfies Record<EditorTool, string>
