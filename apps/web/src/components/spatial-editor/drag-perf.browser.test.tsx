/**
 * SPIKE-ONLY measurement harness (not a regression test). Measures the real
 * cost of the drag render path on a realistic canvas in a real browser.
 */
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { EditorCommand } from './commands.js'
import { applyCommand } from './commands.js'
import { renderCanvasToSvg } from './scene-render.js'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const BODY = [
  '# Sprint planning notes',
  '',
  'We need to decide the **rollout order** for the new sync layer.',
  'Blocked on the migration review from the platform team.',
  '',
  '- Draft the schema change',
  '- Get sign-off from review',
  '- Ship behind a flag',
  '',
  'See `docs/contributing/development.md` for the checklist.',
].join('\n')

/** 80 multi-line text nodes in a 10-wide grid, plus 40 edges. */
function realisticCanvas(count = 80): SpatialCanvas {
  const nodes: SpatialNode[] = []
  for (let i = 0; i < count; i++) {
    nodes.push({
      id: `n${i}`,
      type: 'text',
      x: (i % 10) * 320,
      y: Math.floor(i / 10) * 260,
      width: 280,
      height: 220,
      text: `${BODY}\n\nNode ${i}`,
    })
  }
  const edges = []
  for (let i = 0; i + 1 < count; i += 2) {
    edges.push({
      id: `e${i}`,
      fromNode: `n${i}`,
      fromSide: 'right' as const,
      toNode: `n${i + 1}`,
      toSide: 'left' as const,
    })
  }
  return { nodes, edges }
}

function stats(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  return {
    n: sorted.length,
    min: +sorted[0].toFixed(2),
    median: +at(0.5).toFixed(2),
    p95: +at(0.95).toFixed(2),
    max: +sorted[sorted.length - 1].toFixed(2),
  }
}

function ControlledEditor({ initial }: { initial: SpatialCanvas }) {
  const [canvas, setCanvas] = useState(initial)
  return (
    <div style={{ width: 1200, height: 800 }}>
      <SpatialEditor
        canvas={canvas}
        onChange={(next: SpatialCanvas, _c: EditorCommand) => setCanvas(next)}
      />
    </div>
  )
}

describe('drag render path cost', () => {
  it('measures renderCanvasToSvg on a realistic canvas (option A viability)', () => {
    const measure = createBrowserMeasureText()
    const report: string[] = []
    for (const count of [10, 50, 80]) {
      const canvas = realisticCanvas(count)
      renderCanvasToSvg(canvas, { measure }) // warm-up
      const samples: number[] = []
      for (let i = 0; i < 12; i++) {
        const t0 = performance.now()
        const { svg } = renderCanvasToSvg(canvas, { measure })
        samples.push(performance.now() - t0)
        expect(svg.length).toBeGreaterThan(0)
      }
      report.push(`renderCanvasToSvg nodes=${count} ${JSON.stringify(stats(samples))}`)
    }
    expect.fail(`MEASUREMENTS\n${report.join('\n')}`)
  })

  it('measures frame timing during a sustained drag', async () => {
    const canvas = realisticCanvas(80)
    render(<ControlledEditor initial={canvas} />)
    const root = document.querySelector('[data-testid="spatial-editor"]') as HTMLElement
    const rect = root.getBoundingClientRect()

    // Frame observer: rAF deltas across the drag.
    const frames: number[] = []
    let last = performance.now()
    let running = true
    const tick = () => {
      if (!running) return
      const now = performance.now()
      frames.push(now - last)
      last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)

    const pt = (x: number, y: number) => ({
      clientX: rect.left + x,
      clientY: rect.top + y,
      pointerId: 1,
      bubbles: true,
      isPrimary: true,
      button: 0,
      pointerType: 'mouse',
    })
    // Select then drag node n0 (top-left, at canvas 0,0 area).
    root.dispatchEvent(new PointerEvent('pointerdown', pt(60, 60)))
    root.dispatchEvent(new PointerEvent('pointerup', pt(60, 60)))
    root.dispatchEvent(new PointerEvent('pointerdown', pt(60, 60)))

    const moveSamples: number[] = []
    const previewX: number[] = []
    for (let i = 0; i < 120; i++) {
      const t0 = performance.now()
      root.dispatchEvent(new PointerEvent('pointermove', pt(60 + i * 3, 60 + i * 2)))
      moveSamples.push(performance.now() - t0)
      await new Promise((r) => setTimeout(r, 8))
      const preview = document.querySelector('[data-testid="drag-preview"] rect')
      if (preview !== null) previewX.push(Number(preview.getAttribute('x')))
    }
    // The preview must actually follow the pointer, not sit still.
    expect(previewX.length).toBeGreaterThan(100)
    expect(previewX[previewX.length - 1] - previewX[0]).toBeGreaterThan(300)
    const t0 = performance.now()
    root.dispatchEvent(new PointerEvent('pointerup', pt(60 + 120 * 3, 60 + 120 * 2)))
    const pointerupCost = performance.now() - t0
    await new Promise((r) => setTimeout(r, 100))
    running = false
    const f = frames.slice(2)
    expect.fail(
      `MEASUREMENTS\npointermove handler ms ${JSON.stringify(stats(moveSamples))}\n` +
        `rAF frame deltas ms ${JSON.stringify(stats(f))}\n` +
        `pointerup commit ms ${pointerupCost.toFixed(2)}\n` +
        `frames>20ms ${f.filter((x) => x > 20).length} of ${f.length}`,
    )
  })
})
