// The theme row in the canvas display settings is the plugin's OWN derived
// form for `visual.theme/v0` (ADR-0030): a pick writes the facet to the
// canvas envelope through the same command every canvas facet takes, and
// "Default" clears it rather than storing a value that means nothing.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CANVAS_SETTINGS_WIDGETS } from './index.js'

afterEach(cleanup)

const THEME_KEY = 'visual.theme/v0'
const canvasIn = (theme: string | undefined): SpatialCanvas => ({
  nodes: [],
  edges: [],
  ...(theme === undefined ? {} : { 'x-whiteboard': { facets: { [THEME_KEY]: { theme } } } }),
})

describe('the canvas theme row', () => {
  it('offers the registered themes as a segmented choice and writes the pick to the canvas', () => {
    const run = vi.fn()
    const widget = CANVAS_SETTINGS_WIDGETS[THEME_KEY]
    expect(widget).toBeDefined()
    const { getByRole } = render(<>{widget?.({ canvas: canvasIn(undefined), run })}</>)
    expect(getByRole('radio', { name: 'Default' })).toBeTruthy()
    expect(getByRole('radio', { name: 'Sketch' })).toBeTruthy()
    fireEvent.click(getByRole('radio', { name: 'Neon' }))
    expect(run).toHaveBeenCalledWith({
      kind: 'set-canvas-facet',
      key: THEME_KEY,
      payload: { theme: 'visual.neon' },
    })
  })

  it('marks the stored theme, and Default clears the facet instead of storing a value', () => {
    const run = vi.fn()
    const widget = CANVAS_SETTINGS_WIDGETS[THEME_KEY]
    const { getByRole } = render(<>{widget?.({ canvas: canvasIn('visual.sketch'), run })}</>)
    expect((getByRole('radio', { name: 'Sketch' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(getByRole('radio', { name: 'Default' }))
    expect(run).toHaveBeenCalledWith({
      kind: 'set-canvas-facet',
      key: THEME_KEY,
      payload: undefined,
    })
  })
})
