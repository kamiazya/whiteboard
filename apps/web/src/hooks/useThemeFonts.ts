import type { SpatialRenderStyle } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { useEffect, useSyncExternalStore } from 'react'
import {
  editingFontFamilyFor,
  loadThemeFontFromSource,
  subscribeThemeFonts,
  themeFamilyFor,
  themeFontsGeneration,
} from '../lib/theme-fonts.js'

/**
 * The number of theme faces that have landed in this tab. A scene keyed
 * on it lays out again when a family a theme names becomes measurable —
 * the same shape as the vendored face's readiness tick.
 */
export function useThemeFontsGeneration(): number {
  return useSyncExternalStore(subscribeThemeFonts, themeFontsGeneration, themeFontsGeneration)
}

/**
 * Asks for the family the canvas draws in under this look, from the
 * catalogue source, the first time a surface needs it — the daemon pass
 * (`useDaemonThemeFonts`) may already hold it, in which case this is a
 * no-op. Keyed on the FAMILY rather than the canvas, so an edit to the
 * board never re-asks; the loader itself refuses a held or in-flight one.
 */
export function useThemeFaceFor(
  canvas: SpatialCanvas,
  style: SpatialRenderStyle | undefined,
): void {
  const family = themeFamilyFor(canvas, style)
  useEffect(() => {
    if (family === undefined) return
    void loadThemeFontFromSource(family)
  }, [family])
}

/**
 * The family the in-place text editors type in under this look, re-read
 * when a face lands so a draft opened before the fetch finishes still
 * switches hands with the scene.
 */
export function useEditingFontFamily(
  canvas: SpatialCanvas,
  style: SpatialRenderStyle | undefined,
): string {
  // Read for its change, not its value: the family below depends on which
  // faces are held, which the generation is the one signal of.
  useThemeFontsGeneration()
  return editingFontFamilyFor(canvas, style)
}
