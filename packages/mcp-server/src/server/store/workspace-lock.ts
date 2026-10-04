import { AsyncLocalStorage } from 'node:async_hooks'

// Per-workspace write barrier.
//
// Background: file-gc walks every document + version of a workspace to
// compute the referenced-fileId set, then unlinks every file not in
// the set. Without a write barrier a concurrent saveDocument() that
// introduces a new image reference between collect and unlink can have
// its file deleted as "dangling". The window is widest on workspaces
// with many versions because the collect pass is O(versions × frontiers).
//
// We serialize the offending writers + GC by chaining their critical
// sections onto a per-workspace Promise queue. The lock is in-process
// only — fine because the daemon is single-process and every blob
// read / write goes through this server. If the daemon is ever forked
// this needs to become a file lock.

const queues = new Map<string, Promise<void>>()

// Reentrancy tracking. A single logical write transaction can legitimately
// nest lock acquisitions for the SAME workspace — e.g. the file-GC pass holds
// the barrier across its whole collect + unlink and catches the workspace
// record up inside it (which takes the lock to import), and
// CacheCoherentDocumentIndex holds it around a `super.*` mutator whose
// workspace-plane write takes it again. Since only one holder can ever be
// active per workspace at a time, a nested acquisition can only be the current holder's own
// continuation re-entering (queueing again would await its own completion
// and deadlock forever). AsyncLocalStorage propagates through awaits along
// the exact call chain that acquired the lock, so it distinguishes true
// reentrancy from a genuinely separate concurrent caller (e.g. an
// unrelated sync-update handler's saveDocument firing at the same time), which
// must still queue normally rather than run concurrently.
const heldByThisChain = new AsyncLocalStorage<ReadonlySet<string>>()

export async function withWorkspaceWriteLock<T>(
  workspaceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const alreadyHeld = heldByThisChain.getStore()
  if (alreadyHeld?.has(workspaceId)) {
    return fn()
  }
  // Read the current tail (may be undefined for a fresh workspace).
  const previous = queues.get(workspaceId) ?? Promise.resolve()
  // Create a new tail that waits for the previous one to settle, then
  // runs fn(). We DON'T let fn's rejection propagate into the queue
  // because that would poison every subsequent acquirer for this
  // workspace — chain on `previous.catch(() => undefined)` instead so
  // the queue keeps draining.
  let release!: () => void
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  queues.set(
    workspaceId,
    previous.catch(() => undefined).then(() => next),
  )
  try {
    await previous
  } catch {
    // Earlier holder threw; we still acquire — file-gc + saveDocument
    // must run independently. The original error has already been
    // surfaced to that caller.
  }
  try {
    const nextHeld = new Set(alreadyHeld ?? [])
    nextHeld.add(workspaceId)
    return await heldByThisChain.run(nextHeld, fn)
  } finally {
    release()
    // Once we drain, drop the entry if we are still the tail so the
    // map does not grow unbounded for short-lived workspaces.
    const tail = queues.get(workspaceId)
    if (tail) {
      // Wait for our own tail to settle before deciding whether to
      // delete; if a new acquirer enqueued after us, the map has
      // already been overwritten and this no-ops.
      tail.then(() => {
        if (queues.get(workspaceId) === tail) queues.delete(workspaceId)
      })
    }
  }
}

// Test-only helper.
export function _resetWorkspaceLocksForTests(): void {
  queues.clear()
}
