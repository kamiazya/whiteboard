// Tier-2 conformance test for this surface (package-canvas-render.md
// decision #8 / the theme-layer slice): `CanvasViewer.tsx` must call
// canvas-render's `layoutSpatialCanvas` WITHOUT a `geometry` override, so it
// always resolves to the shared `SPATIAL_THEME_GEOMETRY` default. `apps/web`
// cannot import `mcp-server` (composition-root-to-composition-root imports
// are rejected by `direction-check.ts`), so this per-surface source scan is
// what actually pins the REAL call site — the shared
// `spatial-geometry-parity.test.ts` in canvas-render only proves the
// mechanism (geometry can't vary by resolver), not that this surface
// exercises it correctly.
import { describe, expect, it } from 'vitest'

const modules = import.meta.glob('./CanvasViewer.tsx', { query: '?raw', import: 'default' })

describe('canvas-viewer geometry conformance', () => {
  it('calls layoutSpatialCanvas with no geometry override', async () => {
    const loader = modules['./CanvasViewer.tsx']
    const source = (await loader?.()) as string
    expect(source).toContain('layoutSpatialCanvas(')
    expect(source).not.toMatch(/geometry\s*:/)
  })
})
