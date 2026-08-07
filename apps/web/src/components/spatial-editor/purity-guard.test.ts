import { describe, expect, it } from 'vitest'

const modules = import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', import: 'default' })

// The theme threading in editor-appearance.ts/scene-render.ts must stay a
// pure function of its `theme` argument — no ambient DOM read. Scoped to
// exactly these two files (not the whole directory) so a rename or a new
// file silently falling out of the scan is caught by the explicit-path
// assertion below, rather than the guard quietly covering zero files.
const SCANNED_PATHS = ['./editor-appearance.ts', './scene-render.ts']

describe('theme resolver purity (no ambient DOM read)', () => {
  it('scans exactly the expected files', () => {
    for (const path of SCANNED_PATHS) {
      expect(Object.keys(modules)).toContain(path)
    }
  })

  for (const path of SCANNED_PATHS) {
    it(`${path} reads no window/document/matchMedia/navigator global`, async () => {
      const loader = modules[path]
      const source = (await loader?.()) as string
      expect(source).not.toMatch(/\bwindow\./)
      expect(source).not.toMatch(/\bdocument\./)
      expect(source).not.toMatch(/\bmatchMedia\(/)
      expect(source).not.toMatch(/\bnavigator\./)
    })
  }

  it('editor-appearance.ts carries no bare color literal (it is a thin adapter, no palette of its own)', async () => {
    // Since the theme-layer slice, every color literal lives in
    // canvas-render's shared palette (theme/spatial-palette.ts) — this file
    // only re-projects that shared palette's values, so it should carry NO
    // hex literal at all, not even inside a palette record of its own.
    const loader = modules['./editor-appearance.ts']
    const source = (await loader?.()) as string
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})

describe('single content path (S10 guardrail)', () => {
  it('raw HTML injection exists ONLY at the two documented scene-svg sinks', async () => {
    // Every user-visible string in the editor renders either as plain React
    // text (palette labels, notices) or through canvas-render's escaping
    // serializer injected at exactly these two places. A third
    // dangerouslySetInnerHTML/innerHTML would be a new, unguarded XSS
    // surface — add it here only with the same serializer-only guarantee.
    const allowed = new Map([
      ['./SpatialEditor.tsx', 1],
      ['./DragPreviewLayer.tsx', 1],
    ])
    for (const [path, loader] of Object.entries(modules)) {
      if (path.endsWith('.test.ts') || path.endsWith('.test.tsx')) continue
      const source = (await loader()) as string
      const injections = (source.match(/dangerouslySetInnerHTML=/g) ?? []).length
      expect({ path, injections }).toEqual({ path, injections: allowed.get(path) ?? 0 })
    }
  })

  it('canvas mutations construct typed EditorCommands (no setter bypasses applyCommand)', async () => {
    // The palette and every tool mode mutate the canvas exclusively by
    // dispatching an EditorCommand through applyCommand — a hand-rolled
    // canvas object spread reaching onChange directly would bypass the
    // command layer sync consumers replay.
    const loader = modules['./SpatialEditor.tsx']
    const source = (await loader?.()) as string
    // The doc comment's `onChange(next, command)` mention is prose, not a
    // call — match call sites by their argument shape: every real call
    // passes a canvas produced by applyCommand (directly or via `running`).
    const callSites = (source.match(/onChange\((running|applyCommand\()/g) ?? []).length
    const allCalls = (source.match(/onChange\(/g) ?? []).length - 1 // minus the doc-comment mention
    expect(allCalls).toBe(callSites)
  })
})
