// The session override (ADR-0030 decision 6) lives in the Display panel as a
// "Draw as" row: what THIS tab draws, never what the document says. It is
// offered only where a host can hold the choice, and it names the registered
// themes through the registry rather than through any facet key.

import type { SpatialRenderStyle } from '@kamiazya/whiteboard-canvas-render'
import { createFacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { bundledPlugins } from '@kamiazya/whiteboard-plugin-visual'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CanvasDisplaySettings } from './CanvasDisplaySettings.js'

afterEach(cleanup)

const canvas: SpatialCanvas = { nodes: [], edges: [] }
const registry = createFacetRegistry(bundledPlugins)

describe('the Draw as row', () => {
  /**
   * A HOST that actually holds the choice, the way `DocumentPage` does.
   *
   * Not a detail of the fixture: the row draws real radios now, and a radio
   * that is already current fires no change event — which is correct, and
   * which an uncontrolled fixture cannot see. Given a spy and a frozen
   * `style` prop, React keeps re-checking "As saved" after every pick, so
   * the last click lands on an already-checked radio and reports nothing.
   * That reads as a broken control and is a broken fixture.
   */
  it('offers as-saved, clean, and a preview per registered theme, and reports the pick', () => {
    const onStyleChange = vi.fn()
    function Host() {
      const [style, setStyle] = useState<SpatialRenderStyle | undefined>(undefined)
      return (
        <CanvasDisplaySettings
          canvas={canvas}
          onChange={vi.fn()}
          facetRegistry={registry}
          style={style}
          onStyleChange={(next) => {
            onStyleChange(next)
            setStyle(next)
          }}
        />
      )
    }
    const { getByRole } = render(<Host />)
    const radio = (name: string) => getByRole('radio', { name }) as HTMLInputElement

    expect(radio('As saved').checked).toBe(true)
    fireEvent.click(radio('Clean'))
    expect(onStyleChange).toHaveBeenLastCalledWith('clean')
    expect(radio('Clean').checked).toBe(true)
    fireEvent.click(radio('Preview sketch'))
    expect(onStyleChange).toHaveBeenLastCalledWith('visual.sketch')
    fireEvent.click(radio('Preview neon'))
    expect(onStyleChange).toHaveBeenLastCalledWith('visual.neon')
    fireEvent.click(radio('As saved'))
    expect(onStyleChange).toHaveBeenLastCalledWith(undefined)
    expect(radio('As saved').checked).toBe(true)
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
    expect((getByRole('radio', { name: 'Clean' }) as HTMLInputElement).checked).toBe(true)
    expect((getByRole('radio', { name: 'As saved' }) as HTMLInputElement).checked).toBe(false)
    rerender(<CanvasDisplaySettings canvas={canvas} onChange={vi.fn()} facetRegistry={registry} />)
    expect(queryByRole('radio', { name: 'As saved' })).toBeNull()
  })
})
