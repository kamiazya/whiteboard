/**
 * Writes this tab has issued but whose IndexedDB transaction may not be open
 * yet, so a read can be told to wait for them.
 *
 * IndexedDB serves transactions in creation order, which is all the ordering
 * anyone needs — until a write is QUEUED rather than issued. A name edit is
 * fire-and-forget: each keystroke queues a snapshot, and while one write is in
 * flight the next only waits its turn, holding no transaction. A page that
 * unmounts there still finishes the queued write (the loop is closed over its
 * own refs), but any read that starts meanwhile — the workspace listing, or
 * the page mounted in its place — opens a transaction first and is answered
 * from before the last keystroke. Measured: a title typed and left immediately
 * came back a character short, in the document AND in the workspace list.
 *
 * So the wait cannot live in either reader, and the queue cannot live in the
 * index: only the writer knows about work it has not issued yet. This module
 * is the one place both halves can see.
 *
 * A tracked promise must never WAIT here, by itself or through a read it
 * makes: reads wait here, so it would wait on itself. That is narrower than
 * "never reads". The registrants are the index's own write transactions and
 * the document controller's save loop, which calls back into the folding
 * index. So the folding index waits here in exactly three methods — its
 * document reads, `listDocuments`, `resolveDocument` and
 * `resolveDocumentById` — and every other method, with every read it makes on
 * its own behalf (the startup fold's legacy rows, the capacity count, the
 * fold-skipped rows, the workspaces registry), goes past the barrier
 * (`IdbDocumentIndex`'s `readsAwaitIssuedWrites: false`). That is sound
 * because the writes queued here are document renames, which change none of
 * those. A tracked caller that reaches one of the three reopens the deadlock;
 * `folding-browser-index.write-barrier.browser.test.tsx` calls every other
 * method from a tracked promise.
 */
const issued = new Set<Promise<unknown>>()

/** Registers a write as outstanding until it settles. Returns it unchanged. */
export function trackIndexWrite<T>(write: Promise<T>): Promise<T> {
  issued.add(write)
  void write
    .catch(() => {})
    .finally(() => {
      issued.delete(write)
    })
  return write
}

/**
 * Settles every write issued so far. Loops rather than awaiting once: a save
 * loop that is finishing can register the next queued write, and a read let
 * through between the two would land in exactly the gap this closes.
 */
export async function indexWritesSettled(): Promise<void> {
  while (issued.size > 0) {
    await Promise.allSettled([...issued])
  }
}
