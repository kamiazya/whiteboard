/**
 * What the canvas says to a screen reader after a verb whose result a menu
 * would otherwise hide. A context menu unmounts the moment it closes, so its
 * announcement lives in a store the always-mounted region reads.
 *
 * One canvas is on screen per page, so a single module-level channel is
 * enough; the text clears after a beat, and the same words repeated inside
 * that beat alternate a trailing no-break space so they still read as a
 * change to the reader's software.
 */
const CLEAR_AFTER_MS = 2000

let text = ''
let timer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

function set(next: string): void {
  text = next
  for (const listener of listeners) listener()
}

export function announceOnCanvas(message: string): void {
  clearTimeout(timer)
  const repeated = message !== '' && message === text.trim()
  set(repeated && text === message ? `${message}\u00a0` : message)
  timer = setTimeout(() => set(''), CLEAR_AFTER_MS)
}

export function subscribeCanvasAnnouncement(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function canvasAnnouncement(): string {
  return text
}
