import { useSyncExternalStore } from 'react'
import { layoutCoreGeneration, subscribeLayoutCore } from '../lib/spatial/layout-core.js'

/**
 * How many times this page's Rust core became available. A surface keyed on
 * it draws again when a core that failed to load at boot loads on a retry,
 * replacing the notice it drew in the meantime without a reload.
 */
export function useLayoutCoreGeneration(): number {
  return useSyncExternalStore(subscribeLayoutCore, layoutCoreGeneration, layoutCoreGeneration)
}
