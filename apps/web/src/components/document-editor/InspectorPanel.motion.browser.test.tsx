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
  // Two DIFFERENT components, because that is what the app does and it is
  // what decides the case: `CommentsRailAside` and `VersionPanel` are
  // distinct types, so React unmounts one and mounts the other. Rendering
  // `<InspectorPanel kind={...}>` directly for both — the first shape of
  // this fixture — keeps ONE instance and changes a prop, which never
  // remounts, never re-runs the entrance, and so cannot reproduce the flash
  // at all. It passed the opacity assertion for entirely the wrong reason.
  function CommentsPane() {
    return (
      <InspectorPanel kind="comments" onClose={() => {}}>
        <p>comments</p>
      </InspectorPanel>
    )
  }
  function HistoryPane() {
    return (
      <InspectorPanel kind="history" onClose={() => {}}>
        <p>history</p>
      </InspectorPanel>
    )
  }
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
          aside={kind === 'comments' ? <CommentsPane /> : <HistoryPane />}
        >
          <p>the editor</p>
        </DocumentPageShell>
      </div>
    )
  }
  render(<Swap />)
  await userEvent.click(page.getByRole('button', { name: 'swap' }))

  const arrived = document.querySelector('[data-testid="history-panel"]')
  expect(arrived).not.toBeNull()
  expect(panel()).toBeNull()

  // And it arrives OPAQUE. The entrance fades in from nothing, which is
  // right for an empty slot and wrong here: the outgoing pane is gone in
  // the same commit, so a fade would leave nothing covering what is under
  // the slot. Measured on the canvas at 390px before this: the incoming
  // pane read 0.00 on the first frame and 0.65 by the fifth, and the dock
  // beneath showed through for all of them.
  expect(arrived?.getAttribute('data-state')).toBe('replaced')
  expect(Number(getComputedStyle(arrived as Element).opacity)).toBe(1)
})

/**
 * The other half of that, and the one a silent regression hides in: the
 * slot going EMPTY has to reset the answer. If it did not, every open after
 * the first would take the replacing path and no pane would ever animate
 * again — with all the other tests here still green, since they open into a
 * fresh mount.
 */
it('animates again the next time it opens into an empty slot', async () => {
  render(<ShellHost />)
  await vi.waitFor(() => expect(panel()).not.toBeNull())

  await userEvent.click(page.getByRole('button', { name: 'toggle' }))
  await vi.waitFor(() => expect(panel()).toBeNull(), { timeout: 4000 })

  await userEvent.click(page.getByRole('button', { name: 'toggle' }))

  const again = panel()
  expect(again?.getAttribute('data-state')).toBe('open')
  expect(again?.getAnimations() ?? []).not.toHaveLength(0)
})

/**
 * The leaving pane is the SAME one, not a fresh copy of it.
 *
 * This is the load-bearing half of holding a pane, and it was wrong while
 * every other test here passed: `leaving` was set in an EFFECT, which runs
 * after the commit in which the slot emptied — so that commit rendered no
 * pane at all, React unmounted it, and the effect mounted a new one. The
 * exit animated, the pane converged, and the tests were green over a pane
 * that was destroyed and rebuilt every time it closed.
 *
 * What it cost in the running app: a remounted `VersionTimeline` refetches,
 * so closing History flashed its "Loading…" for two frames and made a
 * request nobody asked for, and anything the pane held — a scroll position,
 * an open preview — went with it.
 *
 * Identity is asserted on the DOM node because that is what a remount
 * replaces and what no amount of "it is still on screen" can distinguish.
 */
it('holds the very same pane on the way out, rather than rebuilding it', async () => {
  render(<ShellHost />)
  await vi.waitFor(() => expect(panel()).not.toBeNull())
  const before = panel()

  await userEvent.click(page.getByRole('button', { name: 'toggle' }))

  expect(panel()).toBe(before)
  await vi.waitFor(() => expect(panel()).toBeNull(), { timeout: 4000 })
})
