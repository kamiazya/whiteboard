/**
 * One editor's conversation with its layout worker: one request in flight,
 * and only the NEWEST input waiting behind it.
 *
 * A stream of remote edits to a large board arrives faster than it lays out,
 * and a worker handed every one lays out every one — each a full layout and a
 * structured clone of the board — to draw only the last. Holding the newest
 * and posting it when the reply lands costs at most one stale frame.
 */

import type { LayoutRequest, LayoutResponse } from '../../lib/layout-worker-protocol.js'

export interface LayoutChannelHandlers<I> {
  /** The request for `inputs`, under the id the channel minted for it. */
  readonly requestFor: (id: number, inputs: I) => LayoutRequest
  /** The reply to the request built from `sent`, whether or not it is still the newest. */
  readonly onReply: (response: LayoutResponse, sent: I, worker: Worker) => void
  /** The worker fired `error`: its module failed to evaluate and no reply will come. */
  readonly onWorkerError: (worker: Worker) => void
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

  const post = (worker: Worker, sent: I) => {
    const id = ++lastId
    const detach = () => {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
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
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    inFlight = { detach }
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
