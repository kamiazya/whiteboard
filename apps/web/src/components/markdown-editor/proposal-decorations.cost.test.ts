// @vitest-environment node
/**
 * What one keystroke costs the proposal projection, COUNTED rather than
 * timed so the number holds on any machine and under any load.
 *
 * The shape is the expensive one: a document holding as many open passage
 * changes as one may, each quoting a passage the body does not contain, so
 * each costs a search of the whole body whenever it is resolved — and a
 * member of a shared workspace can write every one of them. The body is
 * smaller than the largest a document may hold because the count does not
 * depend on its size, and the projection that sets the changes up has to
 * search it once per change however the keystroke is answered.
 *
 * Counted through the model's exports, which is where every whole-body search
 * the web makes goes: a resolution, or a search for a quote's occurrences.
 */
import { EditorState } from '@codemirror/state'
import {
  DOCUMENT_MAX_OPEN_CHANGES,
  type Proposal,
  type ProposedChange,
} from '@kamiazya/whiteboard-model'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { proposalDecorations, setProposalProjection } from './proposal-decorations.js'

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
const PER_PROPOSAL = 100

function absentPassage(index: number): ProposedChange {
  // Absent from BODY: no sentence of it contains a digit.
  const exact = `${index} `.repeat(QUOTE_CHARS).slice(0, QUOTE_CHARS)
  return {
    id: `c${index}`,
    op: 'body.replace',
    status: 'open',
    anchor: { kind: 'text', quote: { exact }, start: 0, end: QUOTE_CHARS },
    text: 'replacement',
    assumed: exact,
  }
}

const PROPOSALS: readonly Proposal[] = Array.from(
  { length: DOCUMENT_MAX_OPEN_CHANGES / PER_PROPOSAL },
  (_, p) => ({
    id: `p${p}`,
    changes: Array.from({ length: PER_PROPOSAL }, (_, c) => absentPassage(p * PER_PROPOSAL + c)),
  }),
)

function reset(): void {
  work.resolutions = 0
  work.longestSearch = 0
  work.wholeBodySearches = 0
}

function projected(): EditorState {
  const state = EditorState.create({ doc: BODY, extensions: [proposalDecorations()] })
  const next = state.update({
    effects: setProposalProjection.of({ proposals: PROPOSALS, selectedChangeId: null }),
  }).state
  // The subject is present: setting the changes up searched for every one.
  expect(work.resolutions + work.wholeBodySearches).toBeGreaterThanOrEqual(
    DOCUMENT_MAX_OPEN_CHANGES,
  )
  return next
}

/** The work one transaction does, after the projection that set it up. */
function measure(state: EditorState, spec: Parameters<EditorState['update']>[0]) {
  reset()
  // `.state`: a transaction builds its state, and runs the fields, only when asked.
  void state.update(spec).state
  return { ...work }
}

beforeEach(reset)

describe('the proposal projection, under every open change a document may hold', () => {
  it('answers a one-character insert without searching the whole body again', () => {
    const cost = measure(projected(), { changes: { from: 10, insert: 'x' } })
    expect(cost.resolutions).toBeLessThanOrEqual(2)
    expect(cost.longestSearch).toBeLessThan(BODY.length / 4)
  })

  it('answers the same proposals sent again without searching the whole body', () => {
    const again = PROPOSALS.map((proposal) => ({ ...proposal, changes: [...proposal.changes] }))
    const cost = measure(projected(), {
      effects: setProposalProjection.of({ proposals: again, selectedChangeId: null }),
    })
    expect(cost.resolutions).toBeLessThanOrEqual(2)
    expect(cost.longestSearch).toBeLessThan(BODY.length / 4)
  })
})
