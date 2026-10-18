import {
  DOCUMENT_MAX_OPEN_CHANGES,
  DOCUMENT_MAX_OPEN_THREADS,
  growsPast,
  OPEN_CHANGES_LIMIT_PHRASE,
  OPEN_THREADS_LIMIT_PHRASE,
  openChangeCount,
  openChangesOnceWritten,
  type Proposal,
} from '@kamiazya/whiteboard-model'

/**
 * Why an edit that leaves `after` threads open, from `before`, is refused —
 * or `undefined` when `DOCUMENT_MAX_OPEN_THREADS` takes it. Each tool words
 * the refusal around it, naming its op.
 */
export function openThreadsRefusal(before: number, after: number): string | undefined {
  if (!growsPast(DOCUMENT_MAX_OPEN_THREADS, before, after)) return undefined
  return `the document would hold ${after} open comment threads, past ${OPEN_THREADS_LIMIT_PHRASE}`
}

/**
 * A proposal refused because writing it would leave the document holding
 * more open proposed changes than `DOCUMENT_MAX_OPEN_CHANGES` — counted across
 * EVERY proposal the document holds, so a series of small proposals cannot
 * pass where one large one would not.
 */
class OpenChangesCeilingError extends Error {
  constructor(readonly open: number) {
    super(
      `the document would hold ${open} open proposed changes, past ${OPEN_CHANGES_LIMIT_PHRASE}. Nothing was written.`,
    )
    this.name = 'OpenChangesCeilingError'
  }
}

/** Throws `OpenChangesCeilingError` when writing `proposal` beside `held` grows past the bound. */
export function refuseOpenChangeGrowth(held: readonly Proposal[], proposal: Proposal): void {
  const after = openChangesOnceWritten(held, proposal)
  if (growsPast(DOCUMENT_MAX_OPEN_CHANGES, openChangeCount(held), after)) {
    throw new OpenChangesCeilingError(after)
  }
}
