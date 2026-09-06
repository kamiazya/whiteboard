/**
 * A comment's body IS markdown, and this is the surface where that became
 * true for a reader.
 *
 * A real browser because the claim is about what is DRAWN: the body goes
 * through canvas-render, which needs a real text measurer, and the width it
 * wraps to comes from a ResizeObserver. jsdom has neither.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CommentBody } from './CommentBody.js'

afterEach(cleanup)

function drawn(container: HTMLElement): string {
  return [...container.querySelectorAll('text')].map((node) => node.textContent ?? '').join('|')
}

it('draws emphasis as emphasis rather than as the four asterisks around it', () => {
  const { container } = render(<CommentBody body="**tighten** this" />)

  // The runs, not one string: canvas-render emits a `<text>` per run, and a
  // strong span is its own run. Asserting on the joined textContent alone
  // would pass over a body that had not been parsed at all.
  // Two runs: the strong span is its own. The space between them is
  // LAYOUT — an x offset on the second run — not a character, so asserting
  // on the joined textContent instead would pass over a body that had never
  // been parsed at all.
  expect(drawn(container)).toBe('tighten|this')
  expect(container.textContent).not.toContain('**')
})

it('draws a heading as a heading, at the metrics the canvas bubble uses', () => {
  const { container } = render(<CommentBody body={'# Ship it\n\nafter review'} />)
  const [heading, body] = [...container.querySelectorAll('text')]
  expect(heading?.textContent).toBe('Ship it')
  expect(body?.textContent).toBe('after review')
  // Size rides the wrapping `<g>`, which is where the backend declares a
  // run's font. 24px is the NODE theme's h1 — the bubble's — against the
  // DOCUMENT theme's 30, which the preview pane passes and which this
  // surface could have reached for by reflex.
  expect(heading?.parentElement?.getAttribute('font-size')).toBe('24')
  expect(body?.parentElement?.getAttribute('font-size')).toBe('16')
})

it('wraps to the width it is given, once the container has been measured', async () => {
  const { container } = render(
    <div style={{ width: 120 }}>
      <CommentBody body={'wrap this sentence until it has to break somewhere sensible'} />
    </div>,
  )
  // The first paint guesses the bubble's own measure, because a rail's width
  // is a layout outcome and no observer has reported yet. The assertion is
  // on what it settles to.
  await vi.waitFor(() => {
    const root = container.querySelector('svg')
    expect(Number(root?.getAttribute('width') ?? 0)).toBeLessThan(130)
  })
  expect([...container.querySelectorAll('text')].length).toBeGreaterThan(1)
})

it('keeps a body that will not parse on screen rather than losing the comment', () => {
  // A message written through the composer is committed text, but a body
  // that arrived from another writer can be anything, and a comment that
  // renders as nothing is a comment nobody can answer.
  const { container } = render(<CommentBody body={'| broken |\n| --'} />)
  expect(container.textContent?.length ?? 0).toBeGreaterThan(0)
})
