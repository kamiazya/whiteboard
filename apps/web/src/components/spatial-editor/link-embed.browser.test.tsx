// External iframe embeds for link nodes (embed spec J6): a click-to-load
// facade appears only above the LOD threshold; activation swaps in a
// sandboxed iframe (no allow-same-origin, no referrer); at most three live
// at once (LRU); collapse returns to the facade. Exports are untouched —
// this layer is editor-only HTML.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const bigLink = (id: string, x: number) =>
  ({
    id,
    type: 'link',
    x,
    y: 60,
    width: 320,
    height: 240,
    url: `https://example.com/${id}`,
  }) as const

function makeHost(initial: SpatialCanvas) {
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(initial)
    return (
      <div style={{ width: 1600, height: 600 }}>
        <SpatialEditor
          defaultTool="select"
          canvas={canvas}
          onChange={(next) => setCanvas(next)}
          theme="light"
        />
      </div>
    )
  }
  return Host
}

it('offers the facade only above the LOD threshold, and activation swaps in a sandboxed iframe', async () => {
  const canvas: SpatialCanvas = {
    nodes: [
      bigLink('l1', 60),
      {
        id: 'small',
        type: 'link',
        x: 500,
        y: 60,
        width: 200,
        height: 60,
        url: 'https://example.com/s',
      },
    ],
    edges: [],
  }
  const Host = makeHost(canvas)
  const { container } = render(<Host />)

  const facades = container.querySelectorAll('[data-testid="link-embed-facade"]')
  expect(facades).toHaveLength(1)

  fireEvent.click(facades[0] as HTMLElement)
  const frame = container.querySelector('[data-testid="link-embed-frame"] iframe')
  expect(frame).not.toBeNull()
  expect(frame?.getAttribute('src')).toBe('https://example.com/l1')
  // Security posture: opaque origin, no referrer.
  expect(frame?.getAttribute('sandbox')).toBe('allow-scripts allow-popups')
  expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer')

  // Collapse returns to the facade.
  fireEvent.click(container.querySelector('[aria-label="Collapse embed"]') as HTMLElement)
  expect(container.querySelector('[data-testid="link-embed-frame"]')).toBeNull()
  expect(container.querySelectorAll('[data-testid="link-embed-facade"]')).toHaveLength(1)
})

it('caps live iframes at three — activating a fourth collapses the oldest', async () => {
  const canvas: SpatialCanvas = {
    nodes: [bigLink('a', 0), bigLink('b', 340), bigLink('c', 680), bigLink('d', 1020)],
    edges: [],
  }
  const Host = makeHost(canvas)
  const { container } = render(<Host />)

  for (const label of ['a', 'b', 'c', 'd']) {
    const facade = container.querySelector(
      `[aria-label="Load https://example.com/${label}"]`,
    ) as HTMLElement
    fireEvent.click(facade)
  }
  const frames = [...container.querySelectorAll('[data-testid="link-embed-frame"] iframe')]
  expect(frames).toHaveLength(3)
  // 'a' (the oldest) collapsed back; b, c, d live.
  expect(frames.map((f) => f.getAttribute('src'))).toEqual([
    'https://example.com/b',
    'https://example.com/c',
    'https://example.com/d',
  ])
})

it('never offers a facade for a non-followable URL scheme', async () => {
  const canvas: SpatialCanvas = {
    nodes: [{ ...bigLink('js', 60), url: 'javascript:alert(1)' } as never],
    edges: [],
  }
  const Host = makeHost(canvas)
  const { container } = render(<Host />)
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="spatial-editor"]')).not.toBeNull(),
  )
  expect(container.querySelector('[data-testid="link-embed-facade"]')).toBeNull()
})
