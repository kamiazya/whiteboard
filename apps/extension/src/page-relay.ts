/**
 * ADR-0050 on Firefox: a page cannot message an extension there, so this
 * content script, injected into the admitted pages only, carries messages
 * between the page's window and the background script's relay. Like the
 * relay it reads nothing it carries — the host validates each request — and
 * keeps only which of the page's named ports is which.
 * https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts#communicating_with_the_web_page
 */
import {
  type WindowFromExtension,
  type WindowFromExtensionBody,
  windowFromPageEnvelopeSchema,
} from '@kamiazya/whiteboard-daemon-client/extension-bridge'
import { WINDOW_BRIDGE_CHANNEL } from '@kamiazya/whiteboard-daemon-client/extension-names'
import type { Port } from './relay.js'

/** The part of the page's `window` the content script uses. */
export interface PageWindow {
  readonly location: { origin: string }
  addEventListener(
    type: 'message',
    listener: (event: { source: unknown; origin: string; data: unknown }) => void,
  ): void
  postMessage(message: unknown, targetOrigin: string): void
}

/** The part of the extension API a content script has. */
export interface ContentScriptApi {
  runtime: { connect(): Port; getManifest(): { version: string } }
}

/** A message on this channel from the page itself, as far as the relay needs to know. */
function fromPage(event: { source: unknown; origin: string; data: unknown }, win: PageWindow) {
  if (event.source !== win || event.origin !== win.location.origin) return null
  // The envelope only: the message a port carries is the page's own, and the
  // host validates it, so a request it will refuse still reaches it and is
  // answered by name.
  const parsed = windowFromPageEnvelopeSchema.safeParse(event.data)
  return parsed.success ? parsed.data : null
}

export function installPageRelay(win: PageWindow, api: ContentScriptApi): void {
  const ports = new Map<string, Port>()
  const post = (message: WindowFromExtensionBody) =>
    win.postMessage(
      {
        channel: WINDOW_BRIDGE_CHANNEL,
        from: 'extension',
        ...message,
      } satisfies WindowFromExtension,
      win.location.origin,
    )

  const open = (name: string) => {
    const port = api.runtime.connect()
    ports.set(name, port)
    port.onMessage.addListener((message) => post({ kind: 'message', port: name, message }))
    port.onDisconnect.addListener(() => {
      ports.delete(name)
      post({ kind: 'disconnect', port: name })
    })
    post({ kind: 'connected', port: name })
  }

  win.addEventListener('message', (event) => {
    const data = fromPage(event, win)
    if (data === null) return
    if (data.kind === 'hello') {
      post({ kind: 'hello', version: api.runtime.getManifest().version })
      return
    }
    if (data.kind === 'connect') open(data.port)
    else if (data.kind === 'message') ports.get(data.port)?.postMessage(data.message)
    else if (data.kind === 'disconnect') {
      ports.get(data.port)?.disconnect()
      ports.delete(data.port)
    }
  })
}
