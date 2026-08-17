// Shared by smokes that wait on a one-shot EventEmitter event (e.g. a
// WebSocket's first 'message') where the producer being silent forever must
// fail loudly with a clear deadline message rather than hang the process —
// the same budgeting discipline this repo's smokes apply to every fetch()
// via AbortController.

/**
 * @param {import('node:events').EventEmitter} emitter
 * @param {string} eventName
 * @param {number} timeoutMs
 * @param {string} timeoutMessage
 * @returns {Promise<unknown>}
 */
export function waitForEventWithTimeout(emitter, eventName, timeoutMs, timeoutMessage) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const onEvent = (data) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(data)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      emitter.removeListener(eventName, onEvent)
      rejectPromise(new Error(timeoutMessage))
    }, timeoutMs)
    emitter.once(eventName, onEvent)
  })
}
