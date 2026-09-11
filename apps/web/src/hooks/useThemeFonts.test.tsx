// The editor asks for the family its canvas draws in: once per family, from
// the catalogue source, and not at all for a look that names none.
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
  facets: { 'visual.theme/v0': { theme: 'visual.sketch' } },
}

afterEach(() => loadThemeFontFromSource.mockClear())

describe('useThemeFaceFor', () => {
  it('asks for the family the canvas draws in, once per family across re-renders', () => {
    const { rerender } = renderHook(
      ({ canvas, style }: { canvas: SpatialCanvas; style?: 'clean' | 'document' }) =>
        useThemeFaceFor(canvas, style),
      { initialProps: { canvas: sketched, style: undefined as 'clean' | 'document' | undefined } },
    )
    expect(loadThemeFontFromSource).toHaveBeenCalledWith('Yomogi')
    rerender({ canvas: { ...sketched, nodes: [] }, style: 'document' })
    expect(loadThemeFontFromSource).toHaveBeenCalledTimes(1)
  })

  it('asks for nothing under the clean look or on an unthemed canvas', () => {
    renderHook(() => useThemeFaceFor(sketched, 'clean'))
    renderHook(() => useThemeFaceFor({ nodes: [], edges: [] }, undefined))
    expect(loadThemeFontFromSource).not.toHaveBeenCalled()
  })
})
