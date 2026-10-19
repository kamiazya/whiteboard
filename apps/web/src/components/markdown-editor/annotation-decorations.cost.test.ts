// @vitest-environment node
/**
 * What one keystroke costs the annotation projection, COUNTED rather than
 * timed so the number holds on any machine and under any load.
 *
 * The shape is the expensive one: a document holding as many open threads as
 * one may, each quoting a passage the body does not contain. An orphan never
 * gets a live mark, so each costs a search of the whole body whenever it is
 * resolved — and a member of a shared workspace can write every one of them.
 * The body is smaller than the largest a document may hold because the count
 * does not depend on its size, and the projection that sets the threads up
 * has to search it once per thread however the keystroke is answered.
 *
 * Counted through the model's exports, which is where every whole-body search
 * the web makes goes: a resolution, or a search for a quote's occurrences.
 */
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { type CommentThread, DOCUMENT_MAX_OPEN_THREADS } from '@kamiazya/whiteboard-model'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { annotationDecorations, setAnnotationProjection } from './annotation-decorations.js'

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

function projected(): EditorState {
  const state = EditorState.create({ doc: BODY, extensions: [annotationDecorations()] })
  const next = state.update({
    effects: setAnnotationProjection.of({ threads: THREADS, selectedThreadId: null }),
  }).state
  // The subject is present: setting the threads up searched for every one.
  expect(work.resolutions + work.wholeBodySearches).toBeGreaterThanOrEqual(THREADS.length)
  return next
}

/** The work one transaction does, after the projection that set it up. */
function measure(state: EditorState, spec: TransactionSpec) {
  reset()
  // `.state`: a transaction builds its state, and runs the fields, only when asked.
  void state.update(spec).state
  return { ...work }
}

function reset(): void {
  work.resolutions = 0
  work.longestSearch = 0
  work.wholeBodySearches = 0
}

beforeEach(reset)

describe('the annotation projection, under every orphan a document may hold', () => {
  // The counter keys a whole-body search on BODY_CHARS, so BODY must be that long.
  beforeAll(() => {
    expect(BODY).toHaveLength(BODY_CHARS)
  })

  it('answers a one-character insert without searching the whole body again', () => {
    const cost = measure(projected(), { changes: { from: 10, insert: 'x' } })
    expect(cost.resolutions).toBeLessThanOrEqual(2)
    expect(cost.longestSearch).toBeLessThan(BODY.length / 4)
  })

  it('answers the same threads sent again without searching the whole body', () => {
    const again = THREADS.map((thread) => ({ ...thread }))
    const cost = measure(projected(), {
      effects: setAnnotationProjection.of({ threads: again, selectedThreadId: null }),
    })
    expect(cost.resolutions).toBeLessThanOrEqual(2)
    expect(cost.longestSearch).toBeLessThan(BODY.length / 4)
  })
})
