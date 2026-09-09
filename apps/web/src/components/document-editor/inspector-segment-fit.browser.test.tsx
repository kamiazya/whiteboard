/**
 * The inspect segment has to FIT the row it sits in.
 *
 * It did not. On a phone its three 44px controls plus the group's own
 * border and padding came to 50px inside a 48px row, so the group's
 * outline crossed the row's top edge and sat on the header's bottom rule —
 * two lines a pixel apart, which is what a reader sees as clutter rather
 * than as one control.
 *
 * Measured on a Pixel 7 before the fix: row `top 48 / bottom 96`, segment
 * `top 46.5 / bottom 96.5`.
 *
 * The coarse size is the one that collides and the one no test can render
 * — the runner emulates no `pointer: coarse` (`dock-button.ts` records the
 * same limit). So the footprint is COMPUTED: the segment's own chrome is
 * measured live from the fine render, and the coarse control height comes
 * from the class string. Nothing here restates a number that lives
 * somewhere else.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import '../../index.css'
import { headerControlSizesPx } from '../ui/header-button.js'
import { InspectorSegment } from './InspectorSegment.js'

afterEach(cleanup)

/**
 * The chrome row's height, read from the bar that draws it rather than
 * pinned here — a second copy would be the thing that goes stale.
 */
function topBarRowHeightPx(): number {
  const sources = import.meta.glob('../WorkspaceTopBar.tsx', {
    query: '?raw',
    eager: true,
    import: 'default',
  }) as Record<string, string>
  const source = Object.values(sources)[0]
  if (source === undefined) throw new Error('WorkspaceTopBar.tsx not found by the scan')
  const heights = [...source.matchAll(/<header[^>]*className="[^"]*?\bh-(\d+)\b/g)].map((m) =>
    Number(m[1]),
  )
  if (heights.length === 0) throw new Error('no header height class found in WorkspaceTopBar.tsx')
  // Both of its headers are the same row; the tallest is the one to fit.
  return Math.max(...heights) * 4
}

it('fits the chrome row at the coarse control size, chrome and all', () => {
  const { container } = render(
    <InspectorSegment open={null} onToggle={() => {}} tabs={{ comments: {}, history: {} }} />,
  )
  const segment = container.querySelector('[data-testid="inspector-segment"]') as HTMLElement
  const button = segment.querySelector('button') as HTMLElement

  const segmentBox = segment.getBoundingClientRect().height
  const buttonBox = button.getBoundingClientRect().height
  // What the GROUP adds around its controls: its border and its padding.
  const chromeAroundControls = segmentBox - buttonBox
  const { fine, coarse } = headerControlSizesPx()

  // The fine render is the one available, so start by confirming it is the
  // size the class promises — otherwise the derived coarse number below is
  // built on a measurement of something else.
  expect(buttonBox).toBe(fine)

  const coarseFootprint = chromeAroundControls + coarse
  expect(coarseFootprint).toBeLessThanOrEqual(topBarRowHeightPx())
})

/**
 * A ground was the obvious way to keep the grouping once the outline had to
 * go, and measuring it is what refused it: the pressed member's `bg-accent`
 * and any `muted` ground are the same token family, so the ground eats the
 * one state a toggle has to show. Against the row, pressed is 0.97 on 1.0
 * (light) and 0.269 on 0.145 (dark); against `bg-muted/50` it is 0.97 on
 * ~0.985 and 0.269 on ~0.207 — about half the separation, both themes.
 */
it('draws no ground of its own, which would swallow the pressed member', () => {
  const { container } = render(
    <InspectorSegment open="history" onToggle={() => {}} tabs={{ comments: {}, history: {} }} />,
  )
  const segment = container.querySelector('[data-testid="inspector-segment"]') as HTMLElement
  const pressed = container.querySelector('[aria-pressed="true"]') as HTMLElement

  expect(getComputedStyle(segment).backgroundColor).toBe('rgba(0, 0, 0, 0)')
  // And the member that is on does paint something, so the assertion above
  // is about a ground that would compete rather than about nothing at all.
  expect(getComputedStyle(pressed).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
})
