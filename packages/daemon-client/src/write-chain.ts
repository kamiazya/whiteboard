/**
 * How a client's writes reach a daemon: one write at a time, each carrying
 * everything the daemon has not acknowledged, and a write that failed sent
 * again until it lands.
 *
 * ONE implementation for both places a page's edits leave from — the
 * SharedWorker's replica and a page that owns its stream hub — because the
 * delivery guarantee is a property of the seam, not of whichever
 * `SseStreamSource` a page happened to get. Two copies of it gave two
 * guarantees: one retried a write the daemon was too busy for, the other
 * dropped it, and the page could not tell which it had.
 */
import { type SyncWriteRefusal, SyncWriteRefusedError } from './api-contracts/sync-write-refusal.js'

const WRITE_RETRY_BASE_MS = 1000
const WRITE_RETRY_MAX_MS = 30_000

/**
 * The wait before attempt `failures + 1`: doubling from one second, held at
 * thirty, so a daemon down for an hour is asked about every thirty seconds and
 * a blip of a second costs a second. A `Retry-After` the daemon gave is a
 * floor under that, never past the ceiling — the edit is held in memory only,
 * and waiting longer than the ceiling is waiting with it at risk.
 */
export function retryDelayMs(failures: number, retryAfterMs: number | null = null): number {
  const backoff = WRITE_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1)
  return Math.min(Math.max(backoff, retryAfterMs ?? 0), WRITE_RETRY_MAX_MS)
}

/**
 * A write the daemon answered with a failure a retry may get past — its own
 * trouble (5xx), or a request it asked to have sent again (408, 429). Carries
 * the daemon's `Retry-After`, in milliseconds, when it gave one.
 */
export class SyncWriteFailedError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(`update refused: ${status}`)
    this.name = 'SyncWriteFailedError'
  }
}

/** A `Retry-After` header (RFC 9110 §10.2.3: delay-seconds or an HTTP-date) in milliseconds. */
export function retryAfterMsOf(header: string | null, now: number = Date.now()): number | null {
  if (header === null) return null
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

/** What the daemon has not acknowledged, and the mark that names it once it has. */
interface OutstandingWrite<Mark> {
  readonly mark: Mark
  readonly bytes: Uint8Array
}

export interface WriteChainOptions<Mark> {
  /**
   * What is outstanding NOW, or `null` when nothing is. Asked before each
   * write, so a write that failed leaves its bytes to be offered again.
   */
  outstanding(): OutstandingWrite<Mark> | null
  /** The daemon took everything `mark` names. */
  acknowledge(mark: Mark): void
  push(bytes: Uint8Array): Promise<void>
  /** The first failure of a run: a write did not land, and will be retried. */
  onFailing(): void
  /** Everything outstanding after a failure has now landed. */
  onLanded(): void
  /**
   * The daemon refused the bytes for what they would do. Nothing more is
   * written until `resume`: the outstanding bytes would be refused every time,
   * and every later edit is built on them.
   */
  onRefused(refusal: SyncWriteRefusal, wasFailing: boolean): void
}

export class WriteChain<Mark> {
  /**
   * One write at a time, so two in flight cannot land out of order and let the
   * later one's acknowledgement cover ops the earlier one never delivered.
   */
  private chain: Promise<void> = Promise.resolve()
  private failures = 0
  private retry: ReturnType<typeof setTimeout> | null = null
  private halted = false
  private closed = false

  constructor(private readonly options: WriteChainOptions<Mark>) {}

  /** A write failed and has not landed since, or bytes were refused and writing has not resumed. */
  get failing(): boolean {
    return this.failures > 0
  }

  /** Write whatever is outstanding, after any write already running. */
  schedule(): void {
    if (this.closed) return
    // The chain never rejects: each link's failure is answered by `failed`.
    this.chain = this.chain.then(() => this.drain()).catch((err: unknown) => this.failed(err))
  }

  /**
   * Writing starts again from a clean account: the refused bytes are gone
   * with whatever held them.
   */
  resume(): void {
    this.halted = false
    this.failures = 0
  }

  /** Nothing is written after this, and no retry fires. */
  close(): void {
    this.closed = true
    this.clearRetry()
  }

  private async drain(): Promise<void> {
    if (this.halted || this.closed) return
    for (;;) {
      const next = this.options.outstanding()
      if (next === null) break
      await this.options.push(next.bytes)
      if (this.closed) return
      this.options.acknowledge(next.mark)
    }
    if (this.failures === 0) return
    this.failures = 0
    this.clearRetry()
    this.options.onLanded()
  }

  private failed(err: unknown): void {
    if (this.closed) return
    if (err instanceof SyncWriteRefusedError) {
      this.clearRetry()
      this.halted = true
      const wasFailing = this.failures > 0
      this.failures += 1
      this.options.onRefused(err.refusal, wasFailing)
      return
    }
    // Retried even with no later edit and no reconnect to carry the bytes: a
    // person who stops typing on a stream that stays up would otherwise keep
    // an unsaved edit until the page closed with it.
    this.failures += 1
    if (this.failures === 1) this.options.onFailing()
    if (this.retry !== null) return
    const retryAfter = err instanceof SyncWriteFailedError ? err.retryAfterMs : null
    this.retry = setTimeout(
      () => {
        this.retry = null
        this.schedule()
      },
      retryDelayMs(this.failures, retryAfter),
    )
  }

  private clearRetry(): void {
    if (this.retry === null) return
    clearTimeout(this.retry)
    this.retry = null
  }
}

interface QueuedUpdate {
  readonly bytes: Uint8Array
  readonly landed: () => void
  readonly dropped: (reason: Error) => void
}

export interface QueuedWriterHooks {
  onFailing(): void
  onLanded(): void
  onRefused(refusal: SyncWriteRefusal): void
}

/**
 * A `WriteChain` for a writer with no replica to diff against: each update is
 * kept, in order, until the daemon has taken it. A write's promise settles
 * when ITS update lands — and, the queue being in order, everything before it
 * — so a caller that reads a settled write as saved is right to.
 *
 * Updates go one per request rather than merged: merging needs the CRDT, and
 * the daemon imports each in order either way.
 */
export class QueuedWriter {
  private readonly queue: QueuedUpdate[] = []
  private readonly chain: WriteChain<QueuedUpdate>

  constructor(push: (bytes: Uint8Array) => Promise<void>, hooks: QueuedWriterHooks) {
    this.chain = new WriteChain<QueuedUpdate>({
      outstanding: () => {
        const head = this.queue[0]
        return head === undefined ? null : { mark: head, bytes: head.bytes }
      },
      acknowledge: (mark) => {
        if (this.queue[0] !== mark) return
        this.queue.shift()
        mark.landed()
      },
      push,
      onFailing: () => hooks.onFailing(),
      onLanded: () => hooks.onLanded(),
      onRefused: (refusal) => {
        // Every update queued behind the refused one is built on it, so none
        // of them can land either; the caller is about to take the daemon's
        // state in their place. Settled rather than failed: a refusal is
        // answered by recovering, not left to the caller as a write to retry.
        for (const queued of this.queue.splice(0)) queued.landed()
        this.chain.resume()
        hooks.onRefused(refusal)
      },
    })
  }

  write(bytes: Uint8Array): Promise<void> {
    return new Promise<void>((landed, dropped) => {
      this.queue.push({ bytes, landed, dropped })
      this.chain.schedule()
    })
  }

  /** Writes still queued are dropped with the writer, and say so. */
  close(): void {
    this.chain.close()
    for (const queued of this.queue.splice(0)) queued.dropped(new Error('writer closed'))
  }
}
