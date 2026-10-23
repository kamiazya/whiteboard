import { useEffect, useState } from 'react'
import { IDENTITY_VIEWPORT, type Viewport } from '../../lib/spatial/viewport.js'
import { readViewport, writeViewport } from '../../lib/spatial/viewport-memory.js'

/**
 * The editor's one viewport state, seeded from what this document last showed
 * and written back as it moves. A remembered position that shows none of the
 * content is not trusted here: the open-on-content check in
 * `use-viewport-controls` frames the content instead. Without a key (a host
 * that has no document identity) nothing is read or kept.
 */
export function useRememberedViewport(memoryKey: string | undefined) {
  const state = useState<Viewport>(
    () => (memoryKey === undefined ? null : readViewport(memoryKey)) ?? IDENTITY_VIEWPORT,
  )
  const viewport = state[0]
  useEffect(() => {
    if (memoryKey !== undefined) writeViewport(memoryKey, viewport)
  }, [memoryKey, viewport])
  return state
}
