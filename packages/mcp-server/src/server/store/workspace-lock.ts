// Per-workspace write barrier.
//
// Background: file-gc walks every canvas + version of a workspace to
// compute the referenced-fileId set, then unlinks every file not in
// the set. Without a write barrier a concurrent saveCanvas() that
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

export async function withWorkspaceWriteLock<T>(
  workspaceId: string,
  fn: () => Promise<T>,
): Promise<T> {
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
    // Earlier holder threw; we still acquire — file-gc + saveCanvas
    // must run independently. The original error has already been
    // surfaced to that caller.
  }
  try {
    return await fn()
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
