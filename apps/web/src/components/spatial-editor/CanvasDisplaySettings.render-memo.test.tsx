// CanvasDisplaySettings re-derives its contribution `groups`
// (resolveFacetContributions(...).map().filter()) in the component body on
// every render, even though facetRegistry/widgets are stable props with
// defaults — recomputing on an unrelated re-render is pure waste.
import { createFacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { bundledPlugins } from '@kamiazya/whiteboard-plugin-visual'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { CanvasDisplaySettings } from './CanvasDisplaySettings.js'
import { CANVAS_SETTINGS_WIDGETS } from './facet-widgets/index.js'

const resolveSpy = vi.fn()

vi.mock('@kamiazya/whiteboard-facet-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kamiazya/whiteboard-facet-engine')>()
  return {
    ...actual,
    resolveFacetContributions: (...args: Parameters<typeof actual.resolveFacetContributions>) => {
      resolveSpy(...args)
      return actual.resolveFacetContributions(...args)
    },
  }
})

afterEach(() => {
  cleanup()
  resolveSpy.mockClear()
})

const canvas: SpatialCanvas = { nodes: [], edges: [] }
const registry = createFacetRegistry(bundledPlugins)

function Host() {
  const [, setTick] = useState(0)
  return (
    <div>
      <button type="button" data-testid="force-rerender" onClick={() => setTick((t) => t + 1)}>
        rerender
      </button>
      <CanvasDisplaySettings
        canvas={canvas}
        onChange={() => {}}
        facetRegistry={registry}
        widgets={CANVAS_SETTINGS_WIDGETS}
      />
    </div>
  )
}

it('does not recompute contribution groups on a re-render with unchanged facetRegistry/widgets', () => {
  const { getByTestId } = render(<Host />)
  expect(resolveSpy).toHaveBeenCalledTimes(1)

  fireEvent.click(getByTestId('force-rerender'))
  expect(resolveSpy).toHaveBeenCalledTimes(1)
})

// The other direction, so a dependency-array regression (e.g. `[]`) cannot
// pass: a CHANGED registry must recompute the groups.
function SwappingHost() {
  const [reg, setReg] = useState(() => createFacetRegistry(bundledPlugins))
  return (
    <div>
      <button
        type="button"
        data-testid="swap-registry"
        onClick={() => setReg(createFacetRegistry(bundledPlugins))}
      >
        swap
      </button>
      <CanvasDisplaySettings
        canvas={canvas}
        onChange={() => {}}
        facetRegistry={reg}
        widgets={CANVAS_SETTINGS_WIDGETS}
      />
    </div>
  )
}

it('recomputes contribution groups when the facetRegistry changes', () => {
  const { getByTestId } = render(<SwappingHost />)
  expect(resolveSpy).toHaveBeenCalledTimes(1)

  fireEvent.click(getByTestId('swap-registry'))
  expect(resolveSpy).toHaveBeenCalledTimes(2)
})
