import { useSyncExternalStore } from 'react'
import { subscribeThemeFonts, themeFontsGeneration } from '../lib/theme-fonts.js'

/**
 * The number of theme faces that have landed in this tab. A scene keyed
 * on it lays out again when a family a theme names becomes measurable —
 * the same shape as the vendored face's readiness tick.
 */
export function useThemeFontsGeneration(): number {
  return useSyncExternalStore(subscribeThemeFonts, themeFontsGeneration, themeFontsGeneration)
}
