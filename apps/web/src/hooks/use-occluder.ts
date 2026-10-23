import { type RefObject, useLayoutEffect } from 'react'
import { registerOccluder } from '../lib/spatial/viewport-insets.js'

/**
 * Registers the element as chrome painted over the canvas while mounted, so
 * the editor beside it treats what it covers as viewport padding.
 */
export function useOccluder(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current
    return element === null ? undefined : registerOccluder(element)
  }, [ref])
}
