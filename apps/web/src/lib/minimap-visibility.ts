/**
 * Whether the collapsed overview is open. View state of one person's session,
 * the same rule as the last-used tool: a new browser session starts hidden,
 * which keeps the drawing area clear on a phone.
 */
const KEY = 'whiteboard:minimap-open'

export function readMinimapOpen(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1'
  } catch {
    // Storage can be unavailable (private mode); hidden is the default anyway.
    return false
  }
}

export function writeMinimapOpen(open: boolean): void {
  try {
    sessionStorage.setItem(KEY, open ? '1' : '0')
  } catch {
    // Losing the preference is survivable; failing the tap is not.
  }
}
