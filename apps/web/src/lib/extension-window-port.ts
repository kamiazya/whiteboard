/**
 * ADR-0050 on Firefox, which lets no page message an extension: the
 * extension's content script relays over this page's own window instead,
 * and this is that relay's page half, shaped as the `runtime.Port` the
 * bridge already speaks through.
 */
import {
  type WindowFromExtension,
  windowFromExtensionSchema,
} from '@kamiazya/whiteboard-daemon-client/extension-bridge'
import { WINDOW_BRIDGE_CHANNEL } from '@kamiazya/whiteboard-daemon-client/extension-names'
import type { BridgePort } from './extension-bridge-fetch.js'

function post(message: object): void {
  window.postMessage({ channel: WINDOW_BRIDGE_CHANNEL, from: 'page', ...message }, location.origin)
}

/** Listens for what the content script posts on this window; answers the stop. */
function listen(on: (message: WindowFromExtension) => void): () => void {
  const listener = (event: MessageEvent) => {
    if (event.origin !== location.origin) return
    const parsed = windowFromExtensionSchema.safeParse(event.data)
    if (parsed.success) on(parsed.data)
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}

/** Whether the extension's content script is on this page. */
export function windowHello(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (present: boolean) => {
      clearTimeout(timer)
      stop()
      resolve(present)
    }
    const stop = listen((message) => {
      if (message.kind === 'hello') finish(true)
    })
    const timer = setTimeout(() => finish(false), timeoutMs)
    post({ kind: 'hello' })
  })
}

/**
 * Opens a port through the content script. With no extension on the page
 * nothing acknowledges it, so it closes after `ackTimeoutMs` rather than
 * holding every request it carries.
 */
export function connectThroughWindow(ackTimeoutMs = 2_000): BridgePort {
  const name = crypto.randomUUID()
  const messageListeners: Array<(message: unknown) => void> = []
  const disconnectListeners: Array<() => void> = []
  let open = true
  const end = () => {
    open = false
    clearTimeout(timer)
    stop()
  }
  const stop = listen((message) => {
    if (message.kind === 'hello' || message.port !== name) return
    if (message.kind === 'connected') clearTimeout(timer)
    else if (message.kind === 'message') for (const l of messageListeners) l(message.message)
    else if (open) {
      end()
      for (const l of disconnectListeners) l()
    }
  })
  const timer = setTimeout(() => {
    end()
    for (const l of disconnectListeners) l()
  }, ackTimeoutMs)
  post({ kind: 'connect', port: name })
  return {
    onMessage: { addListener: (l) => messageListeners.push(l) },
    onDisconnect: { addListener: (l) => disconnectListeners.push(l) },
    postMessage: (message) => {
      if (open) post({ kind: 'message', port: name, message })
    },
    // As with a runtime port, closing it from this side calls no listener.
    disconnect: () => {
      if (!open) return
      post({ kind: 'disconnect', port: name })
      end()
    },
  }
}
