// ADR-0040 decision 6: the board's legend stands in the editor's corner
// when a scoped-tag key carries the colour, and is absent otherwise — the
// same SceneLegend the layout attached, read off the worker's scene.

import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const carried: SpatialCanvas = {
  nodes: [
    textNode({
      id: 'a',
      x: 80,
      y: 80,
      width: 200,
      height: 100,
      text: 'API',
      tags: ['health:ok'],
      color: '4',
    }),
    textNode({
      id: 'b',
      x: 400,
      y: 80,
      width: 200,
      height: 100,
      text: 'DB',
      tags: ['health:failing'],
      color: '1',
    }),
  ],
  edges: [],
}

it('shows the legend for a board whose colour a key carries, with that key’s values', async () => {
  const { container } = render(
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor defaultTool="select" canvas={carried} onChange={() => {}} theme="light" />
    </div>,
  )
  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="legend-overlay"]')).not.toBeNull()
  })
  const legend = container.querySelector('[data-testid="legend-overlay"]') as HTMLElement
  expect(legend.textContent).toContain('health')
  expect(legend.textContent).toContain('failing')
  expect(legend.textContent).toContain('ok')
  // The swatch is the colour the box is drawn in: the scene's own fill.
  const boxFill = (
    container.querySelector('svg g[data-wb-key="a"] rect') as SVGRectElement | null
  )?.getAttribute('fill')
  const swatch = legend.querySelector(
    '[data-testid="legend-boxes-ok"] span[aria-hidden]',
  ) as HTMLElement
  expect(boxFill).toBeTruthy()
  expect(swatch.style.background).toBe(hexToRgb(boxFill as string))
})

it('a board with nothing to say shows no legend', async () => {
  const plain: SpatialCanvas = {
    nodes: [textNode({ id: 'a', x: 80, y: 80, width: 200, height: 100, text: 'A' })],
    edges: [],
  }
  const { container } = render(
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor defaultTool="select" canvas={plain} onChange={() => {}} theme="light" />
    </div>,
  )
  await vi.waitFor(() => {
    expect(container.querySelector('svg g[data-wb-key="a"]')).not.toBeNull()
  })
  expect(container.querySelector('[data-testid="legend-overlay"]')).toBeNull()
})

function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

// ADR-0040 decision 5: a box carrying a value the workspace's library
// colours, and no colour of its own, is drawn in that colour on the editor's
// own surface, and the legend names the key — the same picture the daemon's
// export and `wb_scene_render` draw.
const declaredOnly: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 80, y: 80, width: 200, height: 100, text: 'API', tags: ['health:ok'] }),
    textNode({
      id: 'b',
      x: 400,
      y: 80,
      width: 200,
      height: 100,
      text: 'DB',
      tags: ['health:failing'],
    }),
  ],
  edges: [],
}
const library = {
  health: {
    exclusive: true,
    values: { ok: { color: '4' as const }, failing: { color: '1' as const } },
  },
}

it('draws a tagged box in the colour the library declares, and lists the key in the legend', async () => {
  const { container } = render(
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor
        defaultTool="select"
        canvas={declaredOnly}
        onChange={() => {}}
        theme="light"
        tagLibrary={library}
      />
    </div>,
  )
  await vi.waitFor(() => {
    expect(container.querySelector('[data-testid="legend-overlay"]')).not.toBeNull()
  })
  const legend = container.querySelector('[data-testid="legend-overlay"]') as HTMLElement
  expect(legend.textContent).toContain('health')
  const fillOf = (id: string) =>
    (
      container.querySelector(`svg g[data-wb-key="${id}"] rect`) as SVGRectElement | null
    )?.getAttribute('fill')
  expect(fillOf('a')).toBe(SPATIAL_LIGHT_PALETTE.presets['4'].fill)
  expect(fillOf('b')).toBe(SPATIAL_LIGHT_PALETTE.presets['1'].fill)
})

it('draws the same board as stored without a library: no legend, no declared fill', async () => {
  const { container } = render(
    <div style={{ width: 800, height: 600 }}>
      <SpatialEditor defaultTool="select" canvas={declaredOnly} onChange={() => {}} theme="light" />
    </div>,
  )
  await vi.waitFor(() => {
    expect(container.querySelector('svg g[data-wb-key="a"] rect')).not.toBeNull()
  })
  expect(container.querySelector('[data-testid="legend-overlay"]')).toBeNull()
  const fill = (
    container.querySelector('svg g[data-wb-key="a"] rect') as SVGRectElement
  ).getAttribute('fill')
  expect(fill).not.toBe(SPATIAL_LIGHT_PALETTE.presets['4'].fill)
})
