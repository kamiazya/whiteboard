import { useSyncExternalStore } from 'react'

/**
 * Where the New control is a thumb's reach rather than a pointer's: a finger,
 * or a viewport too narrow for a dropdown to sit beside its trigger.
 *
 * One query so the two reasons cannot disagree about which surface a create
 * opens. A runtime without `matchMedia` (jsdom) answers false, the
 * fine-pointer default.
 */
export const COMPACT_CREATE_QUERY = '(pointer: coarse), (max-width: 639px)'

function subscribe(notify: () => void): () => void {
  if (typeof matchMedia === 'undefined') return () => {}
  const list = matchMedia(COMPACT_CREATE_QUERY)
  list.addEventListener('change', notify)
  return () => list.removeEventListener('change', notify)
}

function read(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia(COMPACT_CREATE_QUERY).matches
}

export function useCompactCreate(): boolean {
  return useSyncExternalStore(subscribe, read, () => false)
}
