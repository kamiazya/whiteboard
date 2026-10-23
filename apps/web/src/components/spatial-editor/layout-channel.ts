/**
 * One editor's conversation with its layout worker: one request in flight,
 * and only the NEWEST input waiting behind it.
 *
 * A stream of remote edits to a large board arrives faster than it lays out,
 * and a worker handed every one lays out every one — each a full layout and a
 * structured clone of the board — to draw only the last. Holding the newest
 * and posting it when the reply lands costs at most one stale frame.
 */

import { getAppLogger } from '../../lib/app-logger.js'
import type { LayoutRequest, LayoutResponse } from '../../lib/layout-worker-protocol.js'

export interface LayoutChannelHandlers<I> {
  /** The request for `inputs`, under the id the channel minted for it. */
  readonly requestFor: (id: number, inputs: I) => LayoutRequest
  /** The reply to the request built from `sent`, whether or not it is still the newest. */
  readonly onReply: (response: LayoutResponse, sent: I, worker: Worker) => void
  /** The worker fired `error`: its module failed to evaluate and no reply will come. */
  readonly onWorkerError: (worker: Worker) => void
}

/**
 * How long a worker may stay silent before its request is posted again.
 *
 * Measured layouts run 0.1-0.4 s even on a 60-node board, and a first request
 * pays the module load and font registration on top (a few seconds on a cold
 * profile under load). 8 s is past both, so a slow-but-alive worker is not
 * interrupted into doing the same layout twice, and short enough that a worker
 * that dropped the message does not leave the board unlaid-out for a minute.
 */
const STALL_MS = 8000

const log = getAppLogger('layout-channel')

function listen(
  worker: Worker,
  onMessage: (e: MessageEvent<LayoutResponse>) => void,
  onError: () => void,
) {
  worker.addEventListener('message', onMessage)
  worker.addEventListener('error', onError)
  return () => {
    worker.removeEventListener('message', onMessage)
    worker.removeEventListener('error', onError)
  }
}

/** One pending timeout at a time; arming replaces, clearing is idempotent. */
function createStallTimer() {
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  return {
    clear,
    arm(onStall: () => void) {
      clear()
      timer = setTimeout(onStall, STALL_MS)
    },
  }
}

export interface LayoutChannel<I> {
  /** Posts `inputs`, or holds them in place of whatever was waiting while a request is out. */
  submit(worker: Worker, inputs: I): void
  /** Stops listening and forgets what was waiting, so a later submit starts clean. */
  reset(): void
}

export function createLayoutChannel<I>(handlers: LayoutChannelHandlers<I>): LayoutChannel<I> {
  let lastId = 0
  let inFlight: { readonly detach: () => void } | null = null
  let pending: I | null = null
  const stall = createStallTimer()
  const post = (worker: Worker, sent: I) => {
    const id = ++lastId
    const detach = () => {
      unlisten()
      stall.clear()
      inFlight = null
    }
    const onMessage = (event: MessageEvent<LayoutResponse>) => {
      if (event.data.id !== id) return
      detach()
      // A failure is answered by laying out the CURRENT inputs on the asking
      // thread, which leaves nothing waiting.
      const next = event.data.type === 'failed' ? null : pending
      pending = null
      handlers.onReply(event.data, sent, worker)
      if (next !== null && next !== sent) post(worker, next)
    }
    const onError = () => {
      detach()
      pending = null
      handlers.onWorkerError(worker)
    }
    const unlisten = listen(worker, onMessage, onError)
    inFlight = { detach }
    stall.arm(() => {
      detach()
      log.warn('layout worker silent; posting the request again')
      const next = pending ?? sent
      pending = null
      post(worker, next)
    })
    worker.postMessage(handlers.requestFor(id, sent))
  }

  return {
    submit(worker, inputs) {
      if (inFlight === null) post(worker, inputs)
      else pending = inputs
    },
    reset() {
      inFlight?.detach()
      pending = null
    },
  }
}
