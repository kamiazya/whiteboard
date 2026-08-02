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
