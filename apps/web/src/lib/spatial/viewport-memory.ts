import { z } from 'zod'
import { clampZoom, type Viewport } from './viewport.js'

const KEY_PREFIX = 'wb.viewport:'

const storedViewportSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().finite(),
})

/**
 * Per document and session-scoped, the same rule as the last-used tool: where
 * you were looking is a property of what you are doing on this document right
 * now, so a reload or a return lands where you left it, while a new browser
 * session starts from the content. Pan and zoom are view state, never document
 * data.
 */
export function readViewport(documentKey: string): Viewport | null {
  try {
    const raw = sessionStorage.getItem(`${KEY_PREFIX}${documentKey}`)
    if (raw === null) return null
    const parsed = storedViewportSchema.safeParse(JSON.parse(raw))
    return parsed.success ? { ...parsed.data, zoom: clampZoom(parsed.data.zoom) } : null
  } catch {
    // Unavailable storage or a damaged entry: opening on the content is a complete fallback.
    return null
  }
}

export function writeViewport(documentKey: string, viewport: Viewport): void {
  try {
    sessionStorage.setItem(`${KEY_PREFIX}${documentKey}`, JSON.stringify(viewport))
  } catch {
    // Losing the position is survivable; failing a pan is not.
  }
}
