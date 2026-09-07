/**
 * The inspector's four panes arrive and leave with motion, in both shapes.
 *
 * A real browser: the claim is that an animation RUNS, which is
 * `getAnimations()`, and jsdom has none. It is pinned on the one vessel
 * rather than per pane deliberately — `InspectorPanel` is what all four
 * stand in, so a fifth inherits this instead of restating it.
 */
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { DocumentPageShell } from './DocumentPageShell.js'
import { InspectorPanel } from './InspectorPanel.js'

afterEach(cleanup)

// The viewport is GLOBAL and the sheet/column split is a `md:` rule that
// reads it, so a test that narrows it would otherwise decide the shape of
// every test after it. Each test states the width it means.
beforeEach(async () => {
  await page.viewport(1024, 700)
})

function Host({ startOpen = true }: { readonly startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen)
  return (
    <div style={{ position: 'relative', width: 390, height: 600 }}>
      <button type="button" onClick={() => setOpen((v) => !v)}>
        toggle
      </button>
      {open ? (
        <InspectorPanel kind="comments" onClose={() => setOpen(false)}>
          <p>a conversation</p>
        </InspectorPanel>
      ) : null}
    </div>
  )
}

const panel = () => document.querySelector('[data-testid="comments-rail"]')

it('rises into place when the slot opens, rather than appearing between two frames', async () => {
  render(<Host startOpen={false} />)
  await userEvent.click(page.getByRole('button', { name: 'toggle' }))

  const el = panel()
  expect(el).not.toBeNull()
  expect(el?.getAnimations() ?? []).not.toHaveLength(0)
})

/**
 * Through the SHELL, not the panel alone: the panel cannot keep itself on
 * screen — its parent is what stops rendering it — so `DocumentPageShell`
 * is where presence lives and where the claim has to be made.
 */
function ShellHost() {
  const [open, setOpen] = useState(true)
  return (
    <div style={{ width: 390, height: 600 }}>
      <DocumentPageShell
        srTitle="a document"
        header={
          <button type="button" onClick={() => setOpen((v) => !v)}>
            toggle
          </button>
        }
        {...(open
          ? {
              aside: (
                <InspectorPanel kind="comments" onClose={() => setOpen(false)}>
                  <p>a conversation</p>
                </InspectorPanel>
              ),
            }
          : {})}
      >
        <p>the editor</p>
      </DocumentPageShell>
    </div>
  )
}

it('stays on screen going out, then lets go', async () => {
  render(<ShellHost />)
  await vi.waitFor(() => expect(panel()).not.toBeNull())

  await userEvent.click(page.getByRole('button', { name: 'toggle' }))

  // Still drawn, and animating: React released the slot, and the pane has
  // not left the screen with it.
  const leaving = panel()
  expect(leaving).not.toBeNull()
  expect(leaving?.getAnimations() ?? []).not.toHaveLength(0)

  // And it converges — a pane stranded on screen would cover the editor.
  await vi.waitFor(() => expect(panel()).toBeNull(), { timeout: 4000 })
})

it('grows between its two stages instead of jumping, on the sheet only', async () => {
  // A phone VIEWPORT, not a narrow container: the sheet shape and its stage
  // toggle are `md:` rules, which read the viewport. Sizing the host alone
  // leaves the toggle `md:hidden` and the click waits forever.
  await page.viewport(390, 700)
  render(<Host />)
  const el = panel()
  if (el === null) throw new Error('no panel')

  await userEvent.click(page.getByRole('button', { name: /expand comments/i }))

  // A height transition, which is only animatable because BOTH ends are
  // definite — 45% and 100%. An `auto` end would not animate at all, and
  // this test would pass over a jump.
  const heights = el.getAnimations().map((a) => (a as CSSTransition).transitionProperty)
  expect(heights).toContain('height')
})

/**
 * A swap is not an exit. The four panes share ONE slot precisely so two are
 * never open at once, and holding the outgoing one on screen while the next
 * plays its entrance would draw exactly that for a beat.
 */
it('replaces one pane with another outright, never showing both', async () => {
  function Swap() {
    const [kind, setKind] = useState<'comments' | 'history'>('comments')
    return (
      <div style={{ width: 390, height: 600 }}>
        <DocumentPageShell
          srTitle="a document"
          header={
            <button type="button" onClick={() => setKind('history')}>
              swap
            </button>
          }
          aside={
            <InspectorPanel kind={kind} onClose={() => {}}>
              <p>{kind}</p>
            </InspectorPanel>
          }
        >
          <p>the editor</p>
        </DocumentPageShell>
      </div>
    )
  }
  render(<Swap />)
  await userEvent.click(page.getByRole('button', { name: 'swap' }))

  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="history-panel"]')).not.toBeNull(),
  )
  expect(panel()).toBeNull()
})
