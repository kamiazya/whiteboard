import { useEffect, useMemo, useRef } from 'react'
import type { ShowResolvedSource } from '../../lib/spatial/editor-handle.js'

/**
 * The "show resolved comments" view state as a source other surfaces can
 * follow. Stable for the editor's life (it reads the latest committed value
 * from a ref), so it can sit in the imperative handle without re-creating it.
 */
export function useShowResolvedSource(show: boolean): ShowResolvedSource {
  const latest = useRef(show)
  const listeners = useRef(new Set<() => void>())
  const source = useMemo<ShowResolvedSource>(
    () => ({
      get: () => latest.current,
      subscribe(listener) {
        listeners.current.add(listener)
        return () => {
          listeners.current.delete(listener)
        }
      },
    }),
    [],
  )
  useEffect(() => {
    if (latest.current === show) return
    latest.current = show
    for (const listener of listeners.current) listener()
  }, [show])
  return source
}
