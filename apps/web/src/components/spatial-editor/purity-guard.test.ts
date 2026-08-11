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
    // String-level TRIPWIRE, not a syntax-aware proof: it catches the ways
    // raw markup realistically enters a React/DOM codebase
    // (dangerouslySetInnerHTML, innerHTML/outerHTML assignment,
    // insertAdjacentHTML). The escaping guarantee itself lives in
    // canvas-render's serializer tests — this test only pins that nothing
    // BUT that serializer's two documented injection points exists here.
    const allowed = new Map([
      // Committed scene + the live-edges drag overlay, both fed solely by
      // canvas-render's escaping serializer.
      ['./SpatialEditor.tsx', 2],
      ['./DragPreviewLayer.tsx', 1],
    ])
    const sinkPattern =
      /dangerouslySetInnerHTML=|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\(/g
    for (const [path, loader] of Object.entries(modules)) {
      if (/\.(test|spec)\.(ts|tsx)$/.test(path)) continue
      const source = (await loader()) as string
      const injections = (source.match(sinkPattern) ?? []).length
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
    // String-level TRIPWIRE for the command boundary: every statement-level
    // onChange call must hand over a canvas spelled `running` (the
    // applyCommand accumulator) or an inline `applyCommand(...)` result.
    // This is deliberately formatting-sensitive and NOT data-flow analysis —
    // a rename or a bypass shows up as a diff in this file, and the
    // behavioral guarantee (sync consumers can replay commands) is carried
    // by the browser-tier tests that assert commands reconstruct the
    // canvas. Prose mentions inside comments don't match: only call sites
    // preceded by code punctuation/whitespace count.
    const callSites = (source.match(/[^`\w]onChange\((running\b|applyCommand\()/g) ?? []).length
    const allCalls = (source.match(/[^`\w]onChange\(/g) ?? []).length
    expect(allCalls).toBe(callSites)
  })
})
