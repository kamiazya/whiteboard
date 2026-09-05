import type { EditorTool } from './editor-tool.js'

const KEY = 'wb.lastTool'

/**
 * Only the two resting tools are remembered. `connect` is a transient
 * drawing mode — restoring it would drop the user into edge-drawing on a
 * canvas they just opened.
 */
type RestingTool = Extract<EditorTool, 'select' | 'hand'>

function isRestingTool(value: unknown): value is RestingTool {
  return value === 'select' || value === 'hand'
}

/**
 * The tool a canvas opens in. An empty canvas is one the user came to
 * FILL, so it opens ready to place and edit; a canvas with content is one
 * they came to READ, so a plain drag pans instead of moving someone's work.
 * Whatever they last chose in this tab wins over both guesses — it is a
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
 * Session-scoped on purpose: the tool is a property of "what I am doing in
 * this tab right now", so a second tab opened for a different task starts
 * from the canvas's own guess rather than inheriting the first tab's mode.
 */
export function readLastTool(): EditorTool | null {
  try {
    const stored = sessionStorage.getItem(KEY)
    return isRestingTool(stored) ? stored : null
  } catch {
    // Storage can be unavailable (private mode, blocked cookies); the
    // canvas-shape guess is a complete fallback.
    return null
  }
}

export function writeLastTool(tool: EditorTool): void {
  if (!isRestingTool(tool)) return
  try {
    sessionStorage.setItem(KEY, tool)
  } catch {
    // Losing the preference is survivable; failing the click is not.
  }
}
