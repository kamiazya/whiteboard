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
 * Asks for the family the canvas draws in, from the catalogue source, the
 * first time a surface needs it — the daemon pass (`useDaemonThemeFonts`)
 * may already hold it, in which case this is a no-op. Keyed on the FAMILY
 * rather than the canvas, so an edit to the board never re-asks; the loader
 * itself refuses a held or in-flight one.
 *
 * Always the DOCUMENT look. The editor draws a canvas in the theme it
 * names, and no UI overrides that any more; ADR-0030 decision 6's argument
 * survives a layer down, where a headless caller still asks for `'clean'`.
 */
export function useThemeFaceFor(canvas: SpatialCanvas): void {
  const family = themeFamilyFor(canvas, 'document')
  useEffect(() => {
    if (family === undefined) return
    void loadThemeFontFromSource(family)
  }, [family])
}

/**
 * The family the in-place text editors type in, re-read when a face lands
 * so a draft opened before the fetch finishes still switches hands with
 * the scene. The document look, for the reason above.
 */
export function useEditingFontFamily(canvas: SpatialCanvas): string {
  // Read for its change, not its value: the family below depends on which
  // faces are held, which the generation is the one signal of.
  useThemeFontsGeneration()
  return editingFontFamilyFor(canvas, 'document')
}
