import { getAppLogger } from './app-logger.js'

/** Whether the edits taken on the replica page are landing in this browser. */
export type ReplicaSaveHealth = 'ok' | 'failed'

export interface ReplicaSaveQueue<Doc> {
  /** Takes the record's current state to storage after a quiet window. */
  schedule(record: Doc): void
  /** Takes the pending save now, if one is waiting; the unmount path. */
  flush(): void
  /** Saves the latest scheduled record again, now; the answer to a `failed` health. */
  retry(): void
  /** Drops what is pending and takes nothing more: the record has nowhere left to go. */
  stop(): void
}

export interface ReplicaSaveQueueOptions<Doc> {
  save: (record: Doc) => Promise<unknown>
  onHealth: (health: ReplicaSaveHealth) => void
  debounceMs?: number
}

const DEFAULT_DEBOUNCE_MS = 500

/** Each save after the one before it, reporting whether it landed. */
function sequentialSaves<Doc>(
  save: ReplicaSaveQueueOptions<Doc>['save'],
  onHealth: ReplicaSaveQueueOptions<Doc>['onHealth'],
): (record: Doc) => void {
  let chain: Promise<void> = Promise.resolve()
  return (record) => {
    chain = chain
      .then(() => save(record))
      .then(
        () => onHealth('ok'),
        (error: unknown) => {
          getAppLogger('replica-save-queue').error('replica save failed', error)
          onHealth('failed')
        },
      )
  }
}

/**
 * The replica page's save queue: one trailing debounce over a sequential
 * chain, reporting whether the last save landed.
 *
 * A failed save is REPORTED, never swallowed: these edits are what
 * `replica-push` later ships to the daemon, the daemon is unreachable, and
 * this browser holds the only copy — text the editor shows that was never
 * appended is text that will never be pushed. Health stays `failed` until a
 * later save lands; the next save appends everything since the last stored
 * state, so one success also covers the edits a failed one left behind.
 *
 * The record is held by reference: a save reads its state at the time it
 * runs, not at the time it was scheduled.
 */
export function createReplicaSaveQueue<Doc>({
  save,
  onHealth,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}: ReplicaSaveQueueOptions<Doc>): ReplicaSaveQueue<Doc> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let latest: Doc | null = null
  let stopped = false
  const saveNow = sequentialSaves(save, onHealth)

  /** Cancels the debounced save, answering whether one was waiting. */
  const cancelTimer = (): boolean => {
    if (timer === null) return false
    clearTimeout(timer)
    timer = null
    return true
  }

  return {
    schedule(record) {
      if (stopped) return
      latest = record
      cancelTimer()
      timer = setTimeout(() => {
        timer = null
        saveNow(record)
      }, debounceMs)
    },
    flush() {
      if (cancelTimer() && latest !== null) saveNow(latest)
    },
    retry() {
      cancelTimer()
      if (latest !== null) saveNow(latest)
    },
    stop() {
      stopped = true
      latest = null
      cancelTimer()
    },
  }
}
