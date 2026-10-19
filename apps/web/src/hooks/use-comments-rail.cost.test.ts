// @vitest-environment jsdom
/**
 * What one keystroke costs the rail's orphan badge, COUNTED rather than timed
 * so the number holds on any machine and under any load.
 *
 * Every row asks `resolveAnchor` whether its thread still has a place, and a
 * keystroke hands the hook a new body. Under as many open threads as a
 * document may hold, each quoting a passage the body does not contain, that
 * was one whole-body search per thread per keystroke. The body is smaller
 * than the largest a document may hold because the count does not depend on
 * its size.
 *
 * Counted through the model's exports, which is where every whole-body search
 * the web makes goes: a resolution, or a search for a quote's occurrences.
 */
import { type CommentThread, DOCUMENT_MAX_OPEN_THREADS } from '@kamiazya/whiteboard-model'
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useCommentsRail } from './use-comments-rail.js'

const BODY_CHARS = vi.hoisted(() => 45 * 750)
const work = vi.hoisted(() => ({ resolutions: 0, longestSearch: 0, wholeBodySearches: 0 }))

vi.mock('@kamiazya/whiteboard-model', async (importOriginal) => {
  const model = await importOriginal<typeof import('@kamiazya/whiteboard-model')>()
  return {
    ...model,
    resolveTextAnchor: (...args: Parameters<typeof model.resolveTextAnchor>) => {
      work.resolutions += 1
      return model.resolveTextAnchor(...args)
    },
    textOccurrences: (...args: Parameters<typeof model.textOccurrences>) => {
      work.longestSearch = Math.max(work.longestSearch, args[0].length)
      if (args[0].length >= BODY_CHARS) work.wholeBodySearches += 1
      return model.textOccurrences(...args)
    },
  }
})

const BODY = 'The quick brown fox jumps over the lazy dog. '.repeat(750)
expect(BODY.length).toBe(BODY_CHARS)
const QUOTE_CHARS = 300

function orphan(index: number): CommentThread {
  // Absent from BODY: no sentence of it contains a digit.
  const exact = `${index} `.repeat(QUOTE_CHARS).slice(0, QUOTE_CHARS)
  return {
    id: `t${index}`,
    anchor: { kind: 'text', quote: { exact }, start: 0, end: QUOTE_CHARS },
    status: 'open',
    messages: [{ id: `t${index}-m1`, body: 'about this' }],
  }
}

const THREADS = Array.from({ length: DOCUMENT_MAX_OPEN_THREADS }, (_, i) => orphan(i))

function reset(): void {
  work.resolutions = 0
  work.longestSearch = 0
  work.wholeBodySearches = 0
}

describe("the rail's orphan badge, under every orphan a document may hold", () => {
  it('answers every row after a one-character insert without searching the whole body again', () => {
    const hook = renderHook(
      ({ body }: { body: string }) =>
        useCommentsRail({
          scopeKey: 'doc-a',
          open: true,
          onOpenChange: () => {},
          threads: THREADS,
          documentKind: 'markdown',
          markdownBody: body,
          canvas: null,
          write: {
            createThread: vi.fn(),
            replyToThread: vi.fn(),
            setThreadStatus: vi.fn(),
            editMessage: vi.fn(),
          },
        }),
      { initialProps: { body: BODY } },
    )
    reset()
    const before = THREADS.map((thread) => hook.result.current.resolveAnchor?.(thread))
    expect(before.every((verdict) => verdict === 'orphaned')).toBe(true)
    // The subject is present: the first answer searched for every thread.
    expect(work.resolutions + work.wholeBodySearches).toBeGreaterThanOrEqual(THREADS.length)

    hook.rerender({ body: `${BODY.slice(0, 10)}x${BODY.slice(10)}` })
    reset()
    const after = THREADS.map((thread) => hook.result.current.resolveAnchor?.(thread))
    expect(after.every((verdict) => verdict === 'orphaned')).toBe(true)
    expect(work.resolutions).toBeLessThanOrEqual(2)
    expect(work.longestSearch).toBeLessThan(BODY.length / 4)
  })
})
