import type { EditorTool } from './editor-tool.js'

const LAST_TOOL_KEY_PREFIX = 'wb.lastTool:'

const keyFor = (documentKey: string) => `${LAST_TOOL_KEY_PREFIX}${documentKey}`

/**
 * Only the two resting tools are remembered. `connect` and `draw` are
 * transient marking modes — restoring either would drop the user into
 * drawing on a canvas they just opened.
 */
type RestingTool = Extract<EditorTool, 'select' | 'hand'>

function isRestingTool(value: unknown): value is RestingTool {
  return value === 'select' || value === 'hand'
}

/**
 * The tool a canvas opens in: Select, whatever the canvas holds. Opening in
 * Hand on a canvas with content made a click select nothing and left the
 * keyboard's node traversal dead, with nothing on screen saying why. A tool
 * this tab last rested in on the same document wins — returning to a canvas
 * mid-session resumes what the user was doing.
 */
export function resolveInitialTool({ lastTool }: { lastTool: EditorTool | null }): EditorTool {
  return isRestingTool(lastTool) ? lastTool : 'select'
}

/**
 * Per document and session-scoped on purpose: the tool is a property of "what
 * I am doing on this canvas right now", so a canvas reopens in the mode it was
 * left in, while a new browser session starts in Select.
 */
export function readLastTool(documentKey: string): EditorTool | null {
  try {
    const stored = sessionStorage.getItem(keyFor(documentKey))
    return isRestingTool(stored) ? stored : null
  } catch {
    // Storage can be unavailable (private mode, blocked cookies); opening
    // in Select is a complete fallback.
    return null
  }
}

export function writeLastTool(documentKey: string, tool: EditorTool): void {
  if (!isRestingTool(tool)) return
  try {
    sessionStorage.setItem(keyFor(documentKey), tool)
  } catch {
    // Losing the preference is survivable; failing the click is not.
  }
}
