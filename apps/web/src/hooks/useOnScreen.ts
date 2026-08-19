/**
 * Whether an element has been on screen yet.
 *
 * The tree draws a miniature of each document, and each miniature costs a
 * fetch of that document's bytes. A workspace's tree can list far more rows
 * than fit, so loading them all is work for documents nobody looked at.
 *
 * ONE-WAY on purpose: once a row has been seen it stays seen. Scrolling away
 * and back would otherwise re-fetch what the row already has, and a
 * miniature that blinks out when it leaves the viewport is worse than one
 * that stays.
 */

import { type RefCallback, useCallback, useRef, useState } from 'react'

export function useOnScreen<T extends Element>(): [RefCallback<T>, boolean] {
  // Absent in older browsers and in some test environments. Answering "seen"
  // there loads everything, which is the behaviour before this existed —
  // never a tree of permanently blank rows.
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined')
  const observerRef = useRef<IntersectionObserver | null>(null)

  const ref = useCallback<RefCallback<T>>((element) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (element === null || typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setSeen(true)
      // Nothing left to watch: the answer cannot go back to false.
      observer.disconnect()
      observerRef.current = null
    })
    observer.observe(element)
    observerRef.current = observer
  }, [])

  return [ref, seen]
}
