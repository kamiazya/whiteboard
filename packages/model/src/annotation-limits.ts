import type { Proposal } from './proposal.js'

/**
 * The most OPEN comment threads, and the most OPEN proposed changes, one
 * document may hold.
 *
 * A COST bound, like the per-canvas ones (`canvas-size`): every render and
 * export of a canvas lays its overlay out again on the loop that answers every
 * other request, and that overlay grows faster than linearly — each comment's
 * bubble, and each proposal's, is placed against every box and every bubble
 * placed before it. Measured with
 * `mcp-server/scripts/measure/comment-and-proposal-cost.mjs` (CPU ms for one
 * layout through the daemon's measurer): at 2000 nodes the board alone takes
 * 0.7 s, with 500 open threads 2.8 s, 1000 threads 5.7 s, 2000 threads 14.4 s;
 * with 1000 open changes, one per proposal, 3.3 s, 2000 changes 7.8 s, 5000
 * changes 54 s. At 300 nodes, 3000 threads take 28 s.
 *
 * Only OPEN ones count, because only they are drawn on the daemon's renders
 * (a resolved thread is drawn only on the reader's own request, a decided
 * change never), and because neither is ever deleted: a bound counting the
 * resolved and decided ones would close a document to comments for good once
 * its history reached it. Resolving a thread, or adopting or dismissing a
 * change, is how a document at the bound takes another.
 *
 * Held per document rather than per canvas so a markdown document's passage
 * threads and proposals answer to it too. 500 open threads is a review that
 * nobody has resolved anything in for a long time; 1000 open changes is five
 * full `wb_canvas_edit` batches proposed and left undecided.
 *
 * Every keeper and tool holds it to `growsPast`: a document stored past a
 * bound still reads, and still takes an edit that opens nothing.
 */
export const DOCUMENT_MAX_OPEN_THREADS = 500

/** See `DOCUMENT_MAX_OPEN_THREADS`. */
export const DOCUMENT_MAX_OPEN_CHANGES = 1000

/**
 * The most messages one comment thread may hold.
 *
 * A STORAGE and read bound rather than a layout one: a thread's messages are
 * never drawn on a render, but every reader of the thread reads all of them —
 * the tools' answers, the comments rail and its cards — and each may be
 * `COMMENT_MESSAGE_MAX_CHARS` long, so an unbounded thread is an unbounded
 * read for everyone who opens it. 1000 replies is far past any conversation a
 * person or an agent holds in one thread; one that long is better continued
 * in a new thread.
 *
 * Counted over every message the thread holds, resolved thread or not, since
 * a message is never deleted and a resolved thread is still read. Held to
 * `growsPast` like the other bounds: a thread stored past it still reads, and
 * still takes an edit to a message it holds, but not another reply.
 */
export const THREAD_MAX_MESSAGES = 1000

/** The per-thread message bound as every refusal of it ends. */
export const THREAD_MESSAGES_LIMIT_PHRASE = `the limit of ${THREAD_MAX_MESSAGES} messages in one comment thread; open a new thread to continue`

/** The open-thread bound as every refusal of it ends. */
export const OPEN_THREADS_LIMIT_PHRASE = `the limit of ${DOCUMENT_MAX_OPEN_THREADS} open comment threads for one document; resolve some first`

/** The open-change bound as every refusal of it ends. */
export const OPEN_CHANGES_LIMIT_PHRASE = `the limit of ${DOCUMENT_MAX_OPEN_CHANGES} open proposed changes for one document; adopt or dismiss some first`

/** How many changes across `proposals` are still open. */
export function openChangeCount(proposals: readonly Proposal[]): number {
  let open = 0
  for (const proposal of proposals) {
    for (const change of proposal.changes) if (change.status === 'open') open += 1
  }
  return open
}

/**
 * How many changes would be open once `proposal` is written beside
 * `proposals`: a proposal already held under its id keeps the changes it
 * holds, and a change written again under an id it holds replaces it — the
 * merge the proposal store performs.
 */
export function openChangesOnceWritten(proposals: readonly Proposal[], proposal: Proposal): number {
  const continuing = proposals.find((held) => held.id === proposal.id)
  const others = proposals.filter((held) => held.id !== proposal.id)
  const written = new Set(proposal.changes.map((change) => change.id))
  const kept = (continuing?.changes ?? []).filter((change) => !written.has(change.id))
  return openChangeCount([...others, { ...proposal, changes: [...kept, ...proposal.changes] }])
}
