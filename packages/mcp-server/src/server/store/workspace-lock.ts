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
// sections onto a per-workspace Promise queue.
//
// The lock is IN-PROCESS: everything it guarantees holds within one
// instance and no further. The local daemon and stdio are one process each
// (they share a data dir with each other, not this lock — the stored
// record's frontier is what keeps them coherent, workspace-doc-cache.ts).
// Server mode may run several instances over one record
// (docs/how-to/self-host-with-docker.md, "Running several instances"), and
// there another instance's write never takes this lock. Per instance it
// gives:
//   - file-GC against a write: across instances that window is covered by
//     the sweep's grace period instead (ADR-0020, and the `file-gc-sweeper`
//     declaration in shared-background-work.ts);
//   - one writer at a time judging a workspace's ceilings against the
//     record it holds: writes through different instances are judged
//     without each other, so concurrent batches can each add the headroom
//     left (the same doc names the overshoot);
//   - the write-admission check below running right before the write.
// Edits themselves need no lock across instances: they are CRDT merges.

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

/**
 * What a writer must still pass when it enters the lock, for the request it
 * serves: rejects to refuse the write. A request is admitted before its body
 * is read, and the body may take as long to arrive as the transport allows;
 * every write to a workspace's content enters this lock, so this is the one
 * place a check can run after the body and right before the change.
 */
type WriteAdmission = (workspaceId: string) => Promise<void>

const admissionOfThisChain = new AsyncLocalStorage<WriteAdmission>()

/**
 * Runs `fn` with `admit` asked on each write lock it enters (not re-entries),
 * until `fn` settles. Work `fn` schedules for later inherits this chain, and
 * once `fn` has answered what it writes was already accepted, so it is not
 * asked again.
 */
export async function runWithWriteAdmission<T>(
  admit: WriteAdmission,
  fn: () => Promise<T>,
): Promise<T> {
  let open = true
  try {
    return await admissionOfThisChain.run(
      (workspaceId) => (open ? admit(workspaceId) : Promise.resolve()),
      fn,
    )
  } finally {
    open = false
  }
}

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
    await admissionOfThisChain.getStore()?.(workspaceId)
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

/**
 * Whether a writer holds this workspace's lock or is queued for it. A writer
 * mutates the cached workspace record before saving it, so a cache that drops
 * the record meanwhile would lose those ops: this is what the cache asks
 * before choosing one to drop. Keyed by workspace id alone, so it answers for
 * every data dir at once — conservative, never unsafe.
 */
export function workspaceWriteLockInUse(workspaceId: string): boolean {
  return queues.has(workspaceId)
}

// Test-only helper.
export function _resetWorkspaceLocksForTests(): void {
  queues.clear()
}
