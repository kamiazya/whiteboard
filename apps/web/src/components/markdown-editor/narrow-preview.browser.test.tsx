// A phone-width editor must not hand the reader a horizontal scrollbar under
// content that has nowhere to go, and must not spend 56px of a 390px screen
// on a rail the document cannot spare.
//
// Real browser, and the assertions target the element that actually scrolls:
// the preview PANE, not the column scroller around it. `max-width` on a block
// never widens it, so the column always fits its parent — what overflows is
// the fixed-width SVG inside the pane's own `overflow: auto`. Measured on the
// reported case: outer 156/156, pane 736/108.
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../index.css'
import { MarkdownEditor } from './MarkdownEditor.js'

// Tailwind decides every width here, so the sheet has to be live before a
// measurement is taken — without it every box measures 0 and an "is it
// narrower than the pane" assertion passes VACUOUSLY.
beforeAll(async () => {
  await vi.waitFor(() => {
    const probe = document.createElement('div')
    probe.className = 'w-full'
    document.body.append(probe)
    const applied = getComputedStyle(probe).width !== 'auto'
    probe.remove()
    if (!applied) throw new Error('index.css not applied yet')
  })
})

// Read mode: what the phone report was taken in, and the only mode where the
// preview owns the full pane. The stored default is 'split'.
//
// RESTORED after every test, not merely set: localStorage is shared by every
// file in the browser project, so a mode left behind here reaches the split
// tests as their starting state — observed as four unrelated failures in
// split-and-scroll.browser.test.tsx, which is a far more confusing report
// than anything this file asserts.
const VIEW_MODE_KEY = 'whiteboard.markdown-view-mode'
beforeEach(() => window.localStorage.setItem(VIEW_MODE_KEY, 'read'))
afterEach(() => {
  cleanup()
  window.localStorage.removeItem(VIEW_MODE_KEY)
  for (const host of document.querySelectorAll('body > div[style*="width"]')) host.remove()
})

const BODY = ['# Title', '', 'あらあ たらたはた たたたああああ ああああ', '', '---', ''].join('\n')
const LONG_BODY = [BODY, ...Array.from({ length: 60 }, (_, i) => `\nparagraph ${i}\n`)].join('\n')

function mountAt(width: number, body = BODY) {
  const host = document.createElement('div')
  host.style.cssText = `width:${width}px;height:600px`
  document.body.append(host)
  return render(<MarkdownEditor value={body} onChange={() => {}} />, { container: host })
}

describe('a phone-width markdown editor', () => {
  // Two tests and three mounts, deliberately: preview-width.test.ts already
  // pins the arithmetic at every width with its own mutation checks, and each
  // mount here is a whole editor. This project's wall clock is load-sensitive
  // enough that a file's cost lands on OTHER files' timeouts, so this one
  // buys only the facts a unit test cannot reach — that the SVG ends up
  // inside the pane, and that the rail waits for something to scroll. The
  // container-width gate is left to `railFits`; asserting it here needed a
  // fourth mount and said nothing the unit test does not.

  // 320 rather than the reported 390: with the rail correctly hidden, 390
  // fits even under the old arithmetic, so a test only there would pass
  // whichever formula is in place.
  it('settles with the preview inside its pane, not scrolling sideways', async () => {
    const { getByTestId } = mountAt(320)
    // Waits for the LAID-OUT width, not the first frame: the preview renders
    // once at `maxWidth` before the ResizeObserver reports the container.
    await vi.waitFor(() => {
      const pane = getByTestId('markdown-preview-pane')
      expect(pane.clientWidth).toBeGreaterThan(0)
      expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth)
    })
  })

  it('keeps the rail away while the whole document is on screen', async () => {
    // The rail doubles as the pane's scrollbar, so a document that fits has
    // nothing for it to mark or seek. Asserted against a LONG document in the
    // same window first: that is what makes "absent" mean absent rather than
    // "the blocks have not arrived yet" — the trap that let an earlier
    // version of this file pass with the gate deleted.
    const long = mountAt(1000, LONG_BODY)
    expect(await long.findByTestId('markdown-minimap-rail')).toBeTruthy()
    const short = mountAt(1000)
    await vi.waitFor(() =>
      expect(short.getByTestId('markdown-preview-pane').clientWidth).toBeGreaterThan(0),
    )
    // Asserts the rail never ARRIVES. A plain null check here passes while it
    // is merely still on its way, which is indistinguishable from absence and
    // left the gate's removal green when it was written that way.
    await expect(
      vi.waitFor(
        () => {
          if (short.queryByTestId('markdown-minimap-rail') === null) throw new Error('not yet')
        },
        { timeout: 1200 },
      ),
    ).rejects.toThrow()
  })
})
