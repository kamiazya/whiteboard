import { useEffect, useRef, useState } from 'react'
import { decodeNaturalSize, type ImageSize } from '../lib/image-natural-size.js'

/**
 * The natural size of each picture in `hrefs`, keyed by href, as each one
 * decodes. The layout is synchronous and has no way to learn a picture's
 * shape, so a body's stand-alone picture draws at its natural size only once
 * this has answered — and as a line-sized run before, or for one that will
 * not decode. A href is decoded once; one that fails is not retried, since
 * the bytes behind a blob: URL do not change.
 */
export function useImageSizes(hrefs: readonly string[]): ReadonlyMap<string, ImageSize> {
  const [sizes, setSizes] = useState<ReadonlyMap<string, ImageSize>>(new Map())
  const asked = useRef(new Set<string>())
  // An array identity changes every render, so the effect keys on the CONTENT.
  const key = [...new Set(hrefs)].sort().join('\n')
  useEffect(() => {
    const wanted = key === '' ? [] : key.split('\n').filter((href) => !asked.current.has(href))
    if (wanted.length === 0) return
    for (const href of wanted) asked.current.add(href)
    let cancelled = false
    void Promise.all(
      wanted.map(async (href) => [href, await decodeNaturalSize(href)] as const),
    ).then((decoded) => {
      if (cancelled) {
        for (const [href] of decoded) asked.current.delete(href)
        return
      }
      const found = decoded.filter(
        (entry): entry is readonly [string, ImageSize] => entry[1] !== undefined,
      )
      if (found.length === 0) return
      setSizes((previous) => new Map([...previous, ...found]))
    })
    return () => {
      cancelled = true
    }
  }, [key])
  return sizes
}
