/**
 * A `SpatialEditor` stand-in that records the props the page hands it.
 *
 * The page tests that use it are about the PAGE's wiring — which theme,
 * which file-ref options, which open handler reached the editor — not about
 * the editor's rendering, so a `<div>` with the props on record is the whole
 * editor they need. Shared so the two keeper fixtures of the document-page
 * contract mock the same module the same way; a `vi.mock` factory is still
 * written in each test file, because vitest hoists it per file.
 */
import type { SpatialEditorProps } from '../components/spatial-editor/index.js'

export const capturedEditorProps: SpatialEditorProps[] = []

export function CapturingSpatialEditor(props: SpatialEditorProps) {
  capturedEditorProps.push(props)
  return <div data-testid="stub-spatial-editor" />
}

/** The props of the most recent render, or null before the editor mounted. */
export function latestEditorProps(): SpatialEditorProps | null {
  return capturedEditorProps.at(-1) ?? null
}

export function resetCapturedEditorProps(): void {
  capturedEditorProps.length = 0
}
