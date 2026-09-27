import type { BrowserPersistenceState } from './browser-persistence-state.js'

type Report = (state: BrowserPersistenceState) => void

/**
 * A document session's account of its writes (SessionDeps.onPersistenceChange):
 * pending from the first edit, saved once nothing is left anywhere behind it,
 * degraded while a write the keeper did not take is outstanding.
 *
 * "Nothing left behind it" is partly the session's to answer — a debounce
 * armed, a commit queued — so it is asked through `busy`; pushes in flight
 * are counted here. Settling is checked after every push settles AND after
 * every commit drains, because a commit that changed nothing produces no
 * push, and without the second check that edit would read as pending forever.
 */
export class PersistenceLedger {
  private unsaved = false
  private inFlightPushes = 0
  // Whether this session has ever written: a storage failure before that is a
  // failed LOAD, which the page shows on its own screen.
  private written = false
  private lastSavedAt: string | null = null
  // A refused write keeps the document unsaved until a LATER write lands;
  // a quiet session after a failure is not a saved one.
  private writeFailed = false
  // Counts failure reports, so a push can tell whether one arrived WHILE it
  // was in flight. The browser backend never rejects a push — its write runs
  // on a queue it owns, and a store that throws is reported through
  // `onError('storage-failure')` while the push's own promise resolves — so
  // "this push resolved" is not "this write landed". A push clears the
  // failure only when no report arrived between its start and its end.
  private failureEpoch = 0

  constructor(
    private readonly report: Report,
    private readonly busy: () => boolean,
  ) {}

  /** A local edit was published. */
  edited(): void {
    if (this.unsaved) return
    this.unsaved = true
    this.report({ kind: 'pending', lastSavedAt: this.lastSavedAt })
  }

  /** A push began; call one of the returned functions when it settles. */
  pushStarted(): { resolved(): void; rejected(): void; dropped(): void } {
    this.inFlightPushes++
    this.written = true
    const epochAtPush = this.failureEpoch
    return {
      resolved: () => {
        this.inFlightPushes--
        if (this.failureEpoch === epochAtPush) this.writeFailed = false
        this.settle()
      },
      rejected: () => {
        this.inFlightPushes--
        this.failed()
      },
      // Settled for a session that has moved on: counted out, reported nowhere.
      dropped: () => {
        this.inFlightPushes--
      },
    }
  }

  /**
   * A write did not land. Counted even after the session settled: a
   * worker-backed push resolves when it is handed over, so the keeper's
   * refusal can arrive after the edit already read as saved.
   */
  storageFailed(): void {
    if (this.written || this.unsaved) this.failed()
  }

  /** Every write outstanding after a failure has now landed. */
  landed(): void {
    this.writeFailed = false
    this.settle()
  }

  /** Report saved if nothing is left behind the last edit. */
  settle(): void {
    if (!this.unsaved || this.writeFailed || this.inFlightPushes > 0 || this.busy()) return
    this.unsaved = false
    this.lastSavedAt = new Date().toISOString()
    this.report({ kind: 'saved', lastSavedAt: this.lastSavedAt })
  }

  private failed(): void {
    this.failureEpoch++
    this.writeFailed = true
    // A write that did not land leaves the document unsaved, even one that
    // had already read as saved — so the landing that ends it settles again.
    this.unsaved = true
    this.report({
      kind: 'degraded',
      reason: 'write-failed',
      message: 'The last write to this browser failed. Your edits stay in memory for this session.',
      lastSavedAt: this.lastSavedAt,
    })
  }
}
