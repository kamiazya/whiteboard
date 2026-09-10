// The session override (ADR-0030 decision 6) lives in the Display panel as a
// "Draw as" row: what THIS tab draws, never what the document says. It is
// offered only where a host can hold the choice, and it names the registered
// themes through the registry rather than through any facet key.
import { createFacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { bundledPlugins } from '@kamiazya/whiteboard-plugin-visual'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasDisplaySettings } from './CanvasDisplaySettings.js'

afterEach(cleanup)

const canvas: SpatialCanvas = { nodes: [], edges: [] }
const registry = createFacetRegistry(bundledPlugins)

describe('the Draw as row', () => {
  it('offers as-saved, clean, and a preview per registered theme, and reports the pick', () => {
    const onStyleChange = vi.fn()
    const { getByRole } = render(
      <CanvasDisplaySettings
        canvas={canvas}
        onChange={vi.fn()}
        facetRegistry={registry}
        style={undefined}
        onStyleChange={onStyleChange}
      />,
    )
    expect(getByRole('button', { name: 'As saved' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(getByRole('button', { name: 'Clean' }))
    expect(onStyleChange).toHaveBeenLastCalledWith('clean')
    fireEvent.click(getByRole('button', { name: 'Preview sketch' }))
    expect(onStyleChange).toHaveBeenLastCalledWith('visual.sketch')
    fireEvent.click(getByRole('button', { name: 'Preview neon' }))
    expect(onStyleChange).toHaveBeenLastCalledWith('visual.neon')
    fireEvent.click(getByRole('button', { name: 'As saved' }))
    expect(onStyleChange).toHaveBeenLastCalledWith(undefined)
  })

  it('marks the current override, and is absent where no host holds one', () => {
    const { getByRole, queryByRole, rerender } = render(
      <CanvasDisplaySettings
        canvas={canvas}
        onChange={vi.fn()}
        facetRegistry={registry}
        style="clean"
        onStyleChange={vi.fn()}
      />,
    )
    expect(getByRole('button', { name: 'Clean' }).getAttribute('aria-pressed')).toBe('true')
    expect(getByRole('button', { name: 'As saved' }).getAttribute('aria-pressed')).toBe('false')
    rerender(<CanvasDisplaySettings canvas={canvas} onChange={vi.fn()} facetRegistry={registry} />)
    expect(queryByRole('button', { name: 'As saved' })).toBeNull()
  })
})
