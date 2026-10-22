/**
 * The rail is 300px wide and comment prose is drawn as an SVG of a measured
 * width, so a column that cannot shrink below its content pushes the text
 * past the panel's edge, where it is clipped.
 */
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import '../../index.css'
import { CommentsPanel } from './CommentsPanel.js'

afterEach(cleanup)

const LONG: CommentThread = {
  id: 't-long',
  anchor: { kind: 'document' },
  status: 'open',
  messages: [
    {
      id: 'm1',
      body: 'Let us list there every place the signup form can fail, then decide which of them deserve an inline message instead of a toast.',
      createdAt: '2026-09-03T00:00:00.000Z',
    },
    {
      id: 'm2',
      body: 'Agreed, and the unreachable-server case should read differently from a validation failure so nobody retries a typo.',
      author: 'assistant',
      createdAt: '2026-09-03T01:00:00.000Z',
    },
  ],
}

it('keeps every message inside the 300px rail', async () => {
  const { container } = render(
    <div data-testid="rail" style={{ width: 300, overflowX: 'auto' }}>
      <div className="p-2">
        <CommentsPanel threads={[LONG]} revealThreadId="t-long" onReply={() => {}} />
      </div>
    </div>,
  )
  await expect
    .element(page.getByTestId('rail').getByText('Agreed', { exact: false }).first())
    .toBeInTheDocument()
  const rail = container.querySelector<HTMLElement>('[data-testid="rail"]')
  expect(rail).not.toBeNull()
  const right = (rail as HTMLElement).getBoundingClientRect().right
  const bodies = [...container.querySelectorAll<HTMLElement>('[data-comment-body]')]
  expect(bodies.length).toBe(2)
  await expect
    .poll(() => (rail as HTMLElement).scrollWidth <= (rail as HTMLElement).clientWidth)
    .toBe(true)
  for (const body of bodies) {
    const drawn = body.querySelector('svg')?.getBoundingClientRect().right ?? 0
    expect(drawn).toBeLessThanOrEqual(right)
    // The drawing stays inside the column it was measured from, not merely
    // inside the rail: the measure and the box it is painted in have to agree.
    expect(drawn).toBeLessThanOrEqual(body.getBoundingClientRect().right + 0.5)
  }
})
