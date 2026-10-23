import { useSyncExternalStore } from 'react'

/**
 * Whether the document browser is on a surface where a thumb is the pointer
 * and the viewport is short of room: a finger, or a viewport too narrow for a
 * dropdown to sit beside its trigger or for a second lane to earn its height.
 *
 * One query so the reasons cannot disagree about which surface a control
 * picks. A runtime without `matchMedia` (jsdom) answers false, the
 * fine-pointer default.
 */
export const COMPACT_SURFACE_QUERY = '(pointer: coarse), (max-width: 639px)'

function subscribe(notify: () => void): () => void {
  if (typeof matchMedia === 'undefined') return () => {}
  const list = matchMedia(COMPACT_SURFACE_QUERY)
  list.addEventListener('change', notify)
  return () => list.removeEventListener('change', notify)
}

function read(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia(COMPACT_SURFACE_QUERY).matches
}

export function useCompactSurface(): boolean {
  return useSyncExternalStore(subscribe, read, () => false)
}
