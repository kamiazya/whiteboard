/**
 * The gutter marker has to be pressable by a thumb.
 *
 * Measured on a 412px phone before this: a 12x12 dot at x=3 — half of WCAG
 * 2.5.8's 24x24 minimum in each dimension, a quarter of its area, and inside
 * the strip the OS keeps for its own back gesture. A synthetic tap aimed at its exact centre
 * always hit it, which is why no test had ever said otherwise.
 *
 * The dot stays 12px because it is chrome beside prose; what grows is the
 * area that answers a press. Asserted through `elementFromPoint`, which is
 * what a press actually consults — a rule in the stylesheet is not evidence
 * that a point reaches the button.
 */
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(cleanup)

const BODY = 'Ship the report on Friday.'
const THREAD: CommentThread = {
  id: 'thread-1',
  anchor: { kind: 'text', quote: { exact: 'report' }, start: 9, end: 15 },
  status: 'open',
  messages: [{ id: 'm1', body: 'Which report?' }],
}

/** WCAG 2.5.8 Target Size (Minimum). */
const MIN_TARGET_PX = 24

it('answers a press anywhere in a 24x24 box around the dot, not just on the dot', async () => {
  const { container } = render(
    <MarkdownEditor
      value={BODY}
      onChange={vi.fn()}
      threads={[THREAD]}
      onSelectThread={vi.fn()}
      onComposeThread={vi.fn()}
    />,
  )
  const marker = await vi.waitFor(() => {
    const found = container.querySelector<HTMLElement>('.cm-annotation-gutter-marker')
    if (found === null) throw new Error('no gutter marker')
    return found
  })
  // The picture stays small: a bigger dot beside prose reads as content.
  const painted = marker.querySelector<HTMLElement>('.cm-annotation-gutter-dot')
  const dot = painted?.getBoundingClientRect()
  expect(Math.round(dot?.width ?? 0)).toBeLessThanOrEqual(14)

  const press = marker.getBoundingClientRect()
  expect(Math.round(press.width)).toBeGreaterThanOrEqual(MIN_TARGET_PX)
  expect(Math.round(press.height)).toBeGreaterThanOrEqual(MIN_TARGET_PX)

  const centre = { x: press.x + press.width / 2, y: press.y + press.height / 2 }
  const half = MIN_TARGET_PX / 2 - 1
  const corners = [
    { x: centre.x - half, y: centre.y - half },
    { x: centre.x + half, y: centre.y - half },
    { x: centre.x - half, y: centre.y + half },
    { x: centre.x + half, y: centre.y + half },
  ]
  for (const point of corners) {
    // Clamped: a target at the viewport's own edge cannot be pressed off it,
    // and what matters is that every point inside the page reaches the button.
    const hit = document.elementFromPoint(Math.max(0, point.x), Math.max(0, point.y))
    expect(hit === marker || marker.contains(hit)).toBe(true)
  }
})
