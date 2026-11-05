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
  // Not cancelled when the set of pictures changes: sizes are keyed by href,
  // and a decode in flight is the only ask its picture will get. React drops
  // the update itself once the hook has unmounted.
  useEffect(() => {
    const wanted = key === '' ? [] : key.split('\n').filter((href) => !asked.current.has(href))
    if (wanted.length === 0) return
    for (const href of wanted) asked.current.add(href)
    void Promise.all(
      wanted.map(async (href) => [href, await decodeNaturalSize(href)] as const),
    ).then((decoded) => {
      const found = decoded.filter(
        (entry): entry is readonly [string, ImageSize] => entry[1] !== undefined,
      )
      if (found.length === 0) return
      setSizes((previous) => new Map([...previous, ...found]))
    })
  }, [key])
  return sizes
}
