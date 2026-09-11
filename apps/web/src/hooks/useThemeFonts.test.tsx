// The editor asks for the family its canvas draws in: once per family, from
// the catalogue source, and not at all for a canvas naming no theme.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const loadThemeFontFromSource = vi.fn(async (_family: string) => true)
vi.mock('../lib/theme-fonts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/theme-fonts.js')>()),
  loadThemeFontFromSource: (family: string) => loadThemeFontFromSource(family),
}))

const { useThemeFaceFor } = await import('./useThemeFonts.js')

const sketched: SpatialCanvas = {
  nodes: [],
  edges: [],
  'x-whiteboard': { facets: { 'visual.theme/v0': { theme: 'visual.sketch' } } },
}

afterEach(() => loadThemeFontFromSource.mockClear())

describe('useThemeFaceFor', () => {
  it('asks for the family the canvas draws in, once per family across re-renders', () => {
    const { rerender } = renderHook(
      ({ canvas }: { canvas: SpatialCanvas }) => useThemeFaceFor(canvas),
      { initialProps: { canvas: sketched } },
    )
    expect(loadThemeFontFromSource).toHaveBeenCalledWith('Yomogi')
    rerender({ canvas: { ...sketched, nodes: [] } })
    expect(loadThemeFontFromSource).toHaveBeenCalledTimes(1)
  })

  it('asks for nothing on a canvas naming no theme', () => {
    renderHook(() => useThemeFaceFor({ nodes: [], edges: [] }))
    expect(loadThemeFontFromSource).not.toHaveBeenCalled()
  })
})
