import { useEffect } from 'react'
import { IDENTITY_VIEWPORT, type Viewport } from '../../lib/spatial/viewport.js'
import { readViewport, writeViewport } from '../../lib/spatial/viewport-memory.js'

/**
 * Where the editor's viewport starts: what this document last showed, else the
 * origin. A remembered position that shows none of the content is not trusted
 * here — the open-on-content check in `use-viewport-controls` frames the
 * content instead. Without a key (a host with no document identity) nothing is
 * read or kept.
 */
export function initialViewport(memoryKey: string | undefined): Viewport {
  return (memoryKey === undefined ? null : readViewport(memoryKey)) ?? IDENTITY_VIEWPORT
}

/** Keeps the document's last viewport for the next time it opens in this session. */
export function useRememberViewport(memoryKey: string | undefined, viewport: Viewport): void {
  useEffect(() => {
    if (memoryKey !== undefined) writeViewport(memoryKey, viewport)
  }, [memoryKey, viewport])
}
