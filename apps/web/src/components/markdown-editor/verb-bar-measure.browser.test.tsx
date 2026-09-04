// The bar measures its own width to decide how many verbs fit, and that
// measurement must SETTLE. It sits in the toolbar of every markdown editor
// in the app, so a measurement that re-renders on each frame starves the
// page it is mounted in — which shows up nowhere near here, as typing that
// arrives truncated in a page test three files away.
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarkdownVerbBar } from './MarkdownVerbBar.js'

afterEach(cleanup)

it('settles its width measurement instead of re-observing every render', async () => {
  const RealResizeObserver = window.ResizeObserver
  let constructed = 0
  class CountingResizeObserver extends RealResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      constructed++
      super(callback)
    }
  }
  window.ResizeObserver = CountingResizeObserver as typeof ResizeObserver
  try {
    // A FRACTIONAL width is the whole point: `clientWidth` rounds and
    // `contentRect.width` does not, so a hook that writes one and reads the
    // other never agrees with itself and re-renders forever.
    render(
      <div style={{ width: '480.5px' }}>
        <MarkdownVerbBar run={() => {}} />
      </div>,
    )
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-testid="markdown-verb-bar"] button').length),
    )
    const afterMount = constructed
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(constructed - afterMount).toBe(0)
    expect(constructed).toBeLessThanOrEqual(2)
  } finally {
    window.ResizeObserver = RealResizeObserver
  }
})
