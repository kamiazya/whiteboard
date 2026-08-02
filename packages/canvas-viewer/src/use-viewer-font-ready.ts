import { useEffect, useState } from 'react'
import { ensureViewerFontLoaded, subscribeViewerFontReady } from './font-loading.js'

/**
 * Kicks off (or joins) the shared viewer-font load and re-renders once it
 * is ready. Unmount-safe by construction: an `ignore` flag guards every
 * `setState`, and the subscription is removed in the effect's cleanup, so a
 * font promise that settles after this component unmounted performs no
 * state update and emits no React warning.
 */
export function useViewerFontReady(): boolean {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let ignore = false

    const unsubscribe = subscribeViewerFontReady(() => {
      if (ignore) return
      setReady(true)
    })

    void ensureViewerFontLoaded().then((status) => {
      if (ignore) return
      if (status === 'loaded') setReady(true)
    })

    return () => {
      ignore = true
      unsubscribe()
    }
  }, [])

  return ready
}
