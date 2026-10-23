/**
 * The paper is never blank while a layout is in flight: a theme switch keeps
 * the previous scene's text drawn until the themed one replaces it, and a
 * board that arrives after the editor mounted (a document opened empty, filled
 * by its first sync) is laid out rather than left as an empty SVG.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const NODES = 13

const board = (nodes: number, theme?: string): SpatialCanvas => ({
  nodes: Array.from({ length: nodes }, (_, i) =>
    textNode({
      id: `n${i}`,
      x: (i % 5) * 260,
      y: Math.floor(i / 5) * 160,
      width: 220,
      height: 120,
      text: `node ${i}`,
    }),
  ),
  edges: [],
  ...(theme === undefined ? {} : { facets: { 'visual.theme/v0': { theme } } }),
})

let setBoard: (c: SpatialCanvas) => void = () => {}
function Host({ initial }: { initial: SpatialCanvas }) {
  const [canvas, set] = useState<SpatialCanvas>(initial)
  setBoard = set
  return (
    <div style={{ width: 1000, height: 700 }}>
      <SpatialEditor canvas={canvas} onChange={set} theme="light" />
    </div>
  )
}

const textCount = (container: HTMLElement) =>
  container.querySelectorAll('[data-testid="canvas-content"] text').length

/** Resolves once the paper's DOM changes, i.e. the themed scene replaced the old one. */
function sceneRedrawn(container: HTMLElement): Promise<void> {
  const content = container.querySelector('[data-testid="canvas-content"]') as HTMLElement
  return new Promise((resolve, reject) => {
    const give = setTimeout(() => reject(new Error('scene never redrawn')), 20_000)
    const observer = new MutationObserver(() => {
      observer.disconnect()
      clearTimeout(give)
      resolve()
    })
    observer.observe(content, { subtree: true, childList: true, attributes: true })
  })
}

/** Animation frames in which the paper held no text while `run` ran. */
async function blankFramesDuring(
  container: HTMLElement,
  run: () => Promise<void>,
): Promise<number> {
  let blank = 0
  let running = true
  const sample = () => {
    if (!running) return
    if (textCount(container) === 0) blank += 1
    requestAnimationFrame(sample)
  }
  sample()
  await run()
  running = false
  return blank
}

it('draws the previous scene through a theme switch', async () => {
  const { container } = render(<Host initial={board(NODES)} />)
  await vi.waitFor(() => expect(textCount(container)).toBeGreaterThan(0))
  const before = textCount(container)
  expect(before).toBe(NODES)
  const blank = await blankFramesDuring(container, async () => {
    await act(async () => setBoard(board(NODES, 'visual.sketch')))
    await sceneRedrawn(container)
  })
  expect(blank).toBe(0)
})

it('lays out a board that arrives after the editor mounted empty', async () => {
  const { container } = render(<Host initial={board(0)} />)
  expect(textCount(container)).toBe(0)
  await act(async () => setBoard(board(NODES)))
  await vi.waitFor(() => expect(textCount(container)).toBe(NODES), { timeout: 20_000 })
})
