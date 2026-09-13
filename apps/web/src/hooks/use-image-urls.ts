/**
 * Object URLs for the stored pictures a render needs, loaded once and revoked
 * together.
 *
 * Extracted rather than copied, for the reason `use-document-file-seams`'s own
 * header gives about the caching rules it holds: there are two surfaces now —
 * the board and the markdown preview — and the subtleties here each exist
 * because of a defect. A failed load must return the SAME map instance, or the
 * fresh (equal) map republishes state, re-runs this effect and spins the failed
 * read forever. An asset is immutable once stored, so a hit is never
 * invalidated; the URLs are revoked on unmount, since leaking them keeps the
 * decoded image alive for the tab's lifetime.
 */
import { useEffect, useRef, useState } from 'react'

export type LoadImageUrl = (ref: string) => Promise<string | undefined>

export function useImageUrls(
  refs: readonly string[],
  load: LoadImageUrl | undefined,
): ReadonlyMap<string, string> {
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map())
  const urlsRef = useRef<ReadonlyMap<string, string>>(urls)
  urlsRef.current = urls

  // Kept in a ref so a caller that rebuilds its loader every render cannot
  // restart the fetch; a loader is a backend binding, not reactive state.
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(
    () => () => {
      for (const url of urlsRef.current.values()) URL.revokeObjectURL(url)
    },
    [],
  )

  // An array identity changes every render, so the effect keys on the CONTENT.
  // The refs are asset ids, which cannot hold a newline.
  const key = refs.join('\n')
  useEffect(() => {
    const loader = loadRef.current
    if (loader === undefined) return
    const wanted = key === '' ? [] : key.split('\n').filter((ref) => !urlsRef.current.has(ref))
    if (wanted.length === 0) return
    let cancelled = false
    // SETTLED, not `Promise.all`: a loader is a backend binding this hook does
    // not own, and one rejection took the whole batch down — installing none
    // of the URLs that had loaded, and going unhandled besides.
    void Promise.all(
      wanted.map(async (ref) => {
        try {
          return [ref, await loader(ref)] as const
        } catch {
          return [ref, undefined] as const
        }
      }),
    ).then((loaded) => {
      if (cancelled) {
        // A URL minted after cleanup is in nobody's map, so the unmount
        // revoke below can never reach it. Dropping it leaks the decoded
        // image for the tab's lifetime.
        for (const [, url] of loaded) if (url !== undefined) URL.revokeObjectURL(url)
        return
      }
      setUrls((prev) => {
        let added = false
        const next = new Map(prev)
        for (const [ref, url] of loaded) {
          if (url !== undefined) {
            next.set(ref, url)
            added = true
          }
        }
        return added ? next : prev
      })
    })
    return () => {
      cancelled = true
    }
  }, [key])

  return urls
}
