/**
 * What a cache of records is, whatever a record is held as: a bounded set of
 * handles by name, each lent to the brackets that read it and given back to
 * whatever lent it to the cache when nothing needs it.
 *
 * A handle is not closed by leaving the cache. Dropping one that a bracket is
 * still reading would close it under that bracket, so a handle that is evicted,
 * replaced or trimmed while lent waits for the last bracket to give it back, and
 * is released then. One that nothing holds is released at once.
 *
 * A `LoroDoc` needs none of this (nothing is given back for it, and collecting
 * it frees it), which is why the default release is a no-op there; an engine
 * lease holds its document in the engine until it is closed, so a cache of
 * leases that forgot an entry without releasing it would hold the memory for
 * good. An unreferenced record may also be released for being idle, which is
 * what lets a daemon give the memory of a workspace nobody is using back.
 */

/** A handle on loan to one bracket; giving it back twice is one return. */
export interface LentRecord<H> {
  readonly handle: H
  give(): void
}

export interface RecordCacheOptions<H> {
  /** How many entries stay resident, the least recently used dropped first. */
  readonly maxEntries: number
  /** Gives a handle back to whatever lent it to the cache. */
  readonly release: (handle: H) => void
  /** Whether a workspace is being written, so its entry must not be dropped from under the writer. */
  readonly pinned: (workspaceId: string) => boolean
  /** An entry nobody holds and nobody has used for this long is dropped and released. Absent: never. */
  readonly idleMs?: number
  /**
   * How a wait is armed, for the idle release. The cache owns no timer: whoever
   * sets an idle time owns the worker that arms it, and declares it as one.
   */
  readonly schedule?: (run: () => void, ms: number) => { cancel(): void }
  /** The entry the bound dropped, as it leaves; not called for an eviction by name. */
  readonly onBoundDrop?: (key: string, handle: H) => void
  readonly now?: () => number
}

interface Entry<H> {
  readonly workspaceId: string
  readonly handle: H
  refs: number
  /** Left the cache: it is released as soon as no bracket holds it. */
  gone: boolean
  lastUsed: number
}

export class RecordCache<H> {
  private readonly entries = new Map<string, Entry<H>>()
  private timer: { cancel(): void } | undefined

  constructor(private readonly options: RecordCacheOptions<H>) {}

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  get size(): number {
    return this.entries.size
  }

  /** The handle kept under `key`, counted as a use; the entry stays where it is when none holds one. */
  get(key: string): H | undefined {
    const entry = this.touched(key)
    return entry?.handle
  }

  /** The same handle, lent: it stays open until the loan is given back, wherever the cache has put the entry meanwhile. */
  acquire(key: string): LentRecord<H> | undefined {
    const entry = this.touched(key)
    if (entry === undefined) return undefined
    entry.refs += 1
    let given = false
    return {
      handle: entry.handle,
      give: () => {
        if (given) return
        given = true
        entry.refs -= 1
        entry.lastUsed = this.now()
        if (entry.gone && entry.refs === 0) this.options.release(entry.handle)
        else this.arm()
      },
    }
  }

  /** Keeps `handle` under `key`, replacing (and giving back) a different one already there. */
  keep(key: string, workspaceId: string, handle: H): void {
    const replaced = this.entries.get(key)
    this.entries.delete(key)
    if (replaced !== undefined && replaced.handle !== handle) this.drop(replaced)
    this.entries.set(key, { workspaceId, handle, refs: 0, gone: false, lastUsed: this.now() })
    this.trim(key)
    this.arm()
  }

  /** Drops the entry under `key` however recently it was used. */
  evict(key: string): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    this.entries.delete(key)
    this.drop(entry)
  }

  /** Drops every entry. */
  clear(): void {
    for (const key of [...this.entries.keys()]) this.evict(key)
    this.disarm()
  }

  private touched(key: string): Entry<H> | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    // Reinserted so Map order is recency order, oldest first.
    this.entries.delete(key)
    this.entries.set(key, entry)
    entry.lastUsed = this.now()
    // A record kept past the bound because its workspace was locked is trimmed by
    // whichever access comes next, so the cache returns to the bound once the
    // lock is released rather than staying over it until another keep.
    this.trim(key)
    this.arm()
    return entry
  }

  /** Marks the entry as having left the cache; its handle goes back when nothing holds it. */
  private drop(entry: Entry<H>): void {
    entry.gone = true
    if (entry.refs === 0) this.options.release(entry.handle)
  }

  /** Drops least recently used entries over the bound, never `keep` nor one whose workspace is locked. */
  private trim(keep: string): void {
    let excess = this.entries.size - this.options.maxEntries
    for (const [candidate, entry] of this.entries) {
      if (excess <= 0) break
      if (candidate === keep || this.options.pinned(entry.workspaceId)) continue
      this.entries.delete(candidate)
      this.options.onBoundDrop?.(candidate, entry.handle)
      this.drop(entry)
      excess -= 1
    }
  }

  /** Drops what nobody holds and nobody has used for the idle time, then waits again if anything is left to wait for. */
  private sweep(): void {
    this.timer = undefined
    const idleMs = this.options.idleMs
    if (idleMs === undefined) return
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.refs > 0 || this.options.pinned(entry.workspaceId)) continue
      if (now - entry.lastUsed < idleMs) continue
      this.entries.delete(key)
      this.drop(entry)
    }
    this.arm()
  }

  /**
   * One wait, for the soonest an entry could go idle, armed only while there is
   * such an entry. A cache with no idle time (or no way to wait) never arms it.
   */
  private arm(): void {
    const idleMs = this.options.idleMs
    if (idleMs === undefined || this.options.schedule === undefined || this.timer !== undefined) {
      return
    }
    const waiting = [...this.entries.values()].filter((entry) => entry.refs === 0)
    if (waiting.length === 0) return
    const soonest = Math.min(...waiting.map((entry) => entry.lastUsed + idleMs))
    const wait = Math.max(0, soonest - this.now())
    this.timer = this.options.schedule(() => this.sweep(), wait)
  }

  private disarm(): void {
    this.timer?.cancel()
    this.timer = undefined
  }
}
