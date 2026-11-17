import type { LayoutCore } from '@kamiazya/whiteboard-canvas-render'
import { currentLayoutCore } from './layout-core.js'

/**
 * The core this realm loaded, which every layout, note and query is answered
 * by: there is no TypeScript to answer in its place (ADR-0054 step 7, S18h).
 * The page awaits it at boot and the worker before its first message, so a
 * layout that reaches here without one is a defect in the realm, and it
 * throws naming that rather than drawing nothing. A failed load throws its
 * own error.
 */
export function requireLayoutCore(): LayoutCore {
  const core = currentLayoutCore()
  if (core === undefined) {
    throw new Error('the layout core is not loaded: this realm lays out before awaiting it')
  }
  return core
}
