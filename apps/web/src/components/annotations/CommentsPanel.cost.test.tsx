/**
 * What a re-render of the comments rail costs in markdown parses, COUNTED
 * rather than timed so the number holds on any machine and under any load.
 *
 * A markdown document's page re-renders the rail on every keystroke — the
 * body is state, and the anchor judge is rebuilt for each body — while the
 * thread list itself is unchanged. Each row's subject is the parsed first
 * message, so a parse per row per render puts the whole list's markdown on
 * every keystroke: as many rows as a document may hold open, each up to a
 * message's full length.
 */
import { type CommentThread, DOCUMENT_MAX_OPEN_THREADS } from '@kamiazya/whiteboard-model'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CommentsPanel } from './CommentsPanel.js'

const work = vi.hoisted(() => ({ parses: 0 }))

vi.mock('@kamiazya/whiteboard-codec', async (importOriginal) => {
  const codec = await importOriginal<typeof import('@kamiazya/whiteboard-codec')>()
  return {
    ...codec,
    parseMarkdownBody: (...args: Parameters<typeof codec.parseMarkdownBody>) => {
      work.parses += 1
      return codec.parseMarkdownBody(...args)
    },
  }
})

function thread(index: number, body = `**point ${index}** about _this_`): CommentThread {
  return {
    id: `t${index}`,
    anchor: { kind: 'document' },
    status: 'open',
    messages: [{ id: `t${index}-m1`, body, createdAt: '2026-09-05T08:00:00.000Z' }],
  }
}

const THREADS = Array.from({ length: DOCUMENT_MAX_OPEN_THREADS }, (_, i) => thread(i))

/** A judge rebuilt per render, the way the page rebuilds one per body. */
const judge = (): ((t: CommentThread) => 'placed' | 'orphaned') => () => 'placed'

beforeEach(() => {
  work.parses = 0
})
afterEach(cleanup)

it('re-renders unchanged rows under a new anchor judge without parsing their bodies again', () => {
  const { rerender } = render(<CommentsPanel threads={THREADS} resolveAnchor={judge()} />)
  // The subject is present: every row drew its parsed subject.
  expect(screen.getAllByRole('listitem')).toHaveLength(THREADS.length)
  expect(screen.getByText('point 0 about this')).not.toBeNull()
  expect(work.parses).toBeGreaterThanOrEqual(THREADS.length)

  work.parses = 0
  rerender(<CommentsPanel threads={THREADS} resolveAnchor={judge()} />)
  expect(work.parses).toBe(0)
})

it('parses only the row whose opening message changed', () => {
  const { rerender } = render(<CommentsPanel threads={THREADS} resolveAnchor={judge()} />)
  work.parses = 0
  const edited = THREADS.map((one, i) => (i === 7 ? thread(7, '_reworded_ point') : one))
  rerender(<CommentsPanel threads={edited} resolveAnchor={judge()} />)
  expect(screen.getByText('reworded point')).not.toBeNull()
  expect(work.parses).toBe(1)
})
