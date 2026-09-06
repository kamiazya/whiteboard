/**
 * Resolving a conversation MOVES it rather than making it disappear.
 *
 * What shipped before was a cut: the row was in the list on one frame and
 * gone on the next, so the press read as "did that work?". The first attempt
 * at a fix crossed the MARKER and left everything else cutting, and frames
 * from a real browser at 130ms showed why that is the same defect one step
 * subtler — the row was already fully muted with its verb already flipped
 * while a 12px dot in the corner was still animating. Every duration was
 * running correctly and the result was indistinguishable from no animation.
 *
 * So the ROW is the subject: it crosses to the resolved look, holds long
 * enough to be read, and only then leaves, with the rows below gliding into
 * the gap by transform. Timings come from the motion tokens; the hold is the
 * one number that is not one yet.
 *
 * Real browser: a transition that is declared and a transition that runs are
 * different claims, and only one of them is visible to jsdom.
 */
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { CommentsPanel } from './CommentsPanel.js'

afterEach(cleanup)

function threadOf(id: string, body: string): CommentThread {
  return {
    id,
    anchor: { kind: 'spatial', x: 10, y: 20 },
    status: 'open',
    messages: [{ id: `${id}-m`, body }],
  }
}

const THREE = [
  threadOf('t-1', 'tighten the copy here'),
  threadOf('t-2', 'the Friday date is stale'),
  threadOf('t-3', 'worth splitting this paragraph'),
]

const rowOf = (id: string) => document.querySelector<HTMLElement>(`li[data-thread-id="${id}"]`)

/**
 * A host that ANSWERS, because a row can only leave a list once the
 * document says it no longer belongs there. A `vi.fn()` host leaves every
 * thread open forever, and the beat then has nothing to hand the row over
 * to — which is a fixture that cannot show the behaviour rather than a
 * behaviour that does not happen.
 */
function StatefulPanel(props: { readonly onResolve?: (id: string, flag: boolean) => void }) {
  const [threads, setThreads] = useState<readonly CommentThread[]>(THREE)
  return (
    <CommentsPanel
      threads={threads}
      onResolve={(id, flag) => {
        props.onResolve?.(id, flag)
        setThreads((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status: flag ? 'resolved' : 'open' } : t)),
        )
      }}
    />
  )
}

it('crosses the WHOLE row to the resolved look, not just the marker beside it', async () => {
  render(<CommentsPanel threads={THREE} onResolve={vi.fn()} />)
  const row = rowOf('t-1')
  if (row === null) throw new Error('no row')

  // Everything the eye is already reading has to be crossing too. The
  // version that transitioned only the dot left the subject and the verb
  // cutting to their new colour, which is what made it read as nothing.
  const crossing = [
    row.querySelector('.annotation-dot'),
    row.querySelector('.comment-row-subject'),
    row.querySelector('.comment-row-meta'),
  ]
  for (const el of crossing) {
    if (el === null) throw new Error('missing row part')
    expect(getComputedStyle(el).transitionDuration).not.toBe('0s')
  }
})

it('holds the resolved row on screen long enough to be read, then lets it leave', async () => {
  render(<StatefulPanel />)
  await userEvent.click(page.getByRole('button', { name: 'Resolve' }).nth(0))

  // Still there, and already SAYING resolved: this beat is the whole fix.
  // The host has not answered yet in this test, so what holds the row is
  // the panel's own beat rather than a stale `threads` prop.
  const row = rowOf('t-1')
  expect(row?.dataset.status).toBe('resolved')

  // And then it goes, without anything else being pressed.
  await vi.waitFor(() => expect(rowOf('t-1')).toBeNull(), { timeout: 4000 })
})

it('glides the rows below into the gap rather than snapping them up', async () => {
  // Both claims are read off the call that CREATES the glide. Neither can be
  // observed after the fact, and each failed under load for its own reason:
  // a `getAnimations()` check has to land inside a 220ms window, and
  // `getBoundingClientRect()` INCLUDES the running transform, so a row
  // caught mid-glide still measures at the place it is travelling from.
  // Measured: the first shape failed 3 of 5 fresh runs, the second passed
  // five in isolation and still failed the whole-project run.
  const glided = new Map<string, number>()
  const realAnimate = Element.prototype.animate
  Element.prototype.animate = function patched(
    this: Element,
    ...args: Parameters<Element['animate']>
  ) {
    const id = (this as HTMLElement).dataset?.threadId
    const from = /translateY\((-?[\d.]+)px\)/.exec(JSON.stringify(args[0] ?? null))
    if (id !== undefined && from !== null) glided.set(id, Number(from[1]))
    return realAnimate.apply(this, args)
  }

  try {
    render(<StatefulPanel />)
    await userEvent.click(page.getByRole('button', { name: 'Resolve' }).nth(0))
    await vi.waitFor(() => expect(rowOf('t-1')).toBeNull(), { timeout: 4000 })

    // A POSITIVE offset: the survivor starts the animation displaced
    // downward, which is where it used to be, and travels up into the gap.
    // A snap would create no animation at all.
    expect(glided.has('t-2')).toBe(true)
    expect(glided.get('t-2')).toBeGreaterThan(0)
  } finally {
    Element.prototype.animate = realAnimate
  }
})

it('leaves the row alone under the All filter, where resolving does not remove it', async () => {
  render(<StatefulPanel />)
  await userEvent.click(page.getByRole('button', { name: 'All' }))
  await userEvent.click(page.getByRole('button', { name: 'Resolve' }).nth(0))

  // Nothing to hold it FOR: the row stays in this list either way, so the
  // crossing is the whole transition and the beat would just be a delay.
  await vi.waitFor(() => expect(rowOf('t-1')?.dataset.status).toBe('resolved'))
  await expect.element(page.getByRole('button', { name: 'Reopen' })).toBeInTheDocument()
  expect(rowOf('t-1')).not.toBeNull()
})

it('writes to the document at once, and only the PRESENTATION waits', async () => {
  // The beat must never delay the write: a peer would see the resolve late,
  // and a reader who navigates away mid-beat would lose it entirely.
  const resolved: [string, boolean][] = []
  render(<StatefulPanel onResolve={(id, flag) => resolved.push([id, flag])} />)
  await userEvent.click(page.getByRole('button', { name: 'Resolve' }).nth(0))
  expect(resolved).toEqual([['t-1', true]])
})
