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
 * The tool a canvas opens in. An empty canvas is one the user came to
 * FILL, so it opens ready to place and edit; a canvas with content is one
 * they came to READ, so a plain drag pans instead of moving someone's work.
 * Whatever they last chose on this document in this session wins over both guesses — it is a
 * stated preference, not an inference.
 */
export function resolveInitialTool({
  isEmpty,
  lastTool,
}: {
  isEmpty: boolean
  lastTool: EditorTool | null
}): EditorTool {
  if (isRestingTool(lastTool)) return lastTool
  return isEmpty ? 'select' : 'hand'
}

/**
 * Per document and session-scoped on purpose: the tool is a property of "what
 * I am doing on this canvas right now", so a canvas reopens in the mode it was
 * left in, while a new browser session starts from the canvas's own guess.
 */
export function readLastTool(documentKey: string): EditorTool | null {
  try {
    const stored = sessionStorage.getItem(keyFor(documentKey))
    return isRestingTool(stored) ? stored : null
  } catch {
    // Storage can be unavailable (private mode, blocked cookies); the
    // canvas-shape guess is a complete fallback.
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
