/**
 * The instrument for the drag-start block, landed before any change to it.
 *
 * Starting a move gesture renders the drag-static backdrop and the ghost
 * synchronously on the main thread (see SpatialEditor's dragStatic memo and
 * its ponytail marker naming the worker upgrade path). That block happens at
 * the worst perceptual moment — the user's hand is literally in motion — so
 * before anything is promoted to a worker, this file measures how big the
 * block actually is on a canvas past the offload threshold.
 *
 * It REPORTS the longest inter-frame gap across the gesture start and pins
 * only what must be true for the number to mean anything: the drag really
 * started (the ghost layer is in the DOM mid-gesture). The gap itself is
 * logged, not asserted — machine-dependent wall time pinned as a threshold
 * is a flake generator, and the number's job is to price the ponytail
 * upgrade, not to gate CI. Read it from the test output.
 *
 * One interaction, one test, same reasoning as
 * worker-scene-responsiveness.browser.test.tsx: heavy canvases measurably
 * raise the parallel project's flake rate, so this file spends its budget
 * once.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import { SpatialEditor } from './SpatialEditor.js'

afterEach(cleanup)

const NODES = 45
const EDGES = 90

// Same shape as worker-scene-responsiveness: enough text to wrap, enough
// edges to route, comfortably past the 12-element offload threshold.
const heavy = (): SpatialCanvas => ({
  nodes: Array.from({ length: NODES }, (_, i) => ({
    id: `n${i}`,
    type: 'text' as const,
    x: (i % 8) * 260,
    y: Math.floor(i / 8) * 180,
    width: 200,
    height: 120,
    text: `node ${i} carries a sentence long enough to wrap somewhere`,
  })),
  edges: Array.from({ length: EDGES }, (_, i) => ({
    id: `e${i}`,
    fromNode: `n${i % NODES}`,
    toNode: `n${(i * 7 + 3) % NODES}`,
  })).filter((e) => e.fromNode !== e.toNode),
})

const frame = () => new Promise((r) => requestAnimationFrame(r))

it('measures the main-thread block at drag start on a heavy canvas', async () => {
  function Host() {
    const [canvas, setCanvas] = useState<SpatialCanvas>(heavy)
    return (
      <div style={{ width: 1000, height: 700 }}>
        <SpatialEditor defaultTool="select" canvas={canvas} onChange={setCanvas} theme="light" />
      </div>
    )
  }
  const { container } = render(<Host />)
  const root = container.querySelector('[data-testid="spatial-editor"]') as HTMLElement
  // Let the mount settle (first scene is synchronous; the worker warms in the
  // background) so the measurement window contains only the gesture start.
  for (let i = 0; i < 5; i++) await frame()

  // Frame-gap recorder, running across the whole gesture start.
  const gaps: number[] = []
  let last = performance.now()
  const recording = true
  const tick = () => {
    const now = performance.now()
    gaps.push(now - last)
    last = now
    if (recording) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  // Node n0 sits at canvas (0,0)-(200,120); the editor fits the scene into
  // view, so hit it through the DOM rect of its rendered text instead of
  // guessing screen coordinates: pointerdown selects, the first past-threshold
  // pointermove starts the move gesture and pays the dragStatic render.
  const r = root.getBoundingClientRect()
  const dragOnce = async (id: number, offset: number) => {
    // The previous gesture MOVED the node by (+80,+60); grab where it is now.
    const grabX = r.left + 60 + offset * 80
    const grabY = r.top + 60 + offset * 60
    const gaps: number[] = []
    let last = performance.now()
    let recording = true
    const tick = () => {
      const now = performance.now()
      gaps.push(now - last)
      last = now
      if (recording) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    fireEvent.pointerDown(root, { pointerId: id, clientX: grabX, clientY: grabY, buttons: 1 })
    await frame()
    fireEvent.pointerMove(root, {
      pointerId: id,
      clientX: grabX + 40,
      clientY: grabY + 40,
      buttons: 1,
    })
    await frame()
    fireEvent.pointerMove(root, {
      pointerId: id,
      clientX: grabX + 80,
      clientY: grabY + 60,
      buttons: 1,
    })
    for (let i = 0; i < 10; i++) await frame()
    recording = false
    // The number only prices anything if a move gesture genuinely started.
    const ghost = container.querySelector('[data-testid="drag-preview"]')
    expect(ghost, 'drag ghost layer should be mounted mid-gesture').not.toBeNull()
    fireEvent.pointerUp(root, { pointerId: id, clientX: grabX + 80, clientY: grabY + 60 })
    for (let i = 0; i < 5; i++) await frame()
    return gaps
  }

  // Twice: the first gesture pays one-time costs (first Canvas 2D measure of
  // this font, lazily-transformed modules under the dev pipeline); the second
  // is the steady state a user feels on every later drag.
  const first = await dragOnce(7, 0)
  const second = await dragOnce(8, 1)
  const summarize = (gaps: number[]) =>
    `maxGapMs=${Math.max(...gaps).toFixed(1)} gapsOver50ms=${gaps.filter((g) => g > 50).length}`
  const report = `[drag-start-instrument] nodes=${NODES} edges=${EDGES} first: ${summarize(first)} second: ${summarize(second)}`
  // eslint-disable-next-line no-console -- the instrument's output IS the point
  console.log(report)
}, 30_000)
