/**
 * ADR-0050 on Firefox: a page cannot message an extension there, so this
 * content script, injected into the admitted pages only, carries messages
 * between the page's window and the background script's relay. Like the
 * relay it reads nothing it carries — the host validates each request — and
 * keeps only which of the page's named ports is which.
 * https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts#communicating_with_the_web_page
 */
import type {
  WindowFromExtension,
  WindowFromExtensionBody,
  WindowFromPageEnvelope,
} from '@kamiazya/whiteboard-daemon-client/extension-bridge'
import {
  BRIDGE_PROTOCOL_VERSION,
  WINDOW_BRIDGE_CHANNEL,
} from '@kamiazya/whiteboard-daemon-client/extension-names'
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

/**
 * The envelope of a page's message, read by hand rather than through
 * `windowFromPageEnvelopeSchema`: the content script runs on every admitted
 * page and the background script on every browser start, and parsing one
 * four-field envelope with zod took the built background script from 3 KB to
 * 143 KB. The schema stays the source of truth — `page-relay.test.ts` holds
 * this reader to it over arbitrary input — and `message` is carried as the
 * page sent it, because the host validates a request and answers a refused
 * one by name, so a relay that judged it would turn a refusal into a hang.
 */
export function readPageEnvelope(data: unknown): WindowFromPageEnvelope | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as { [K in 'channel' | 'from' | 'kind' | 'port' | 'message']?: unknown }
  if (d.channel !== WINDOW_BRIDGE_CHANNEL || d.from !== 'page') return null
  const envelope = { channel: WINDOW_BRIDGE_CHANNEL, from: 'page' } as const
  if (d.kind === 'hello') return { ...envelope, kind: 'hello' }
  if (typeof d.port !== 'string' || d.port === '' || d.port.length > 64) return null
  if (d.kind === 'connect' || d.kind === 'disconnect')
    return { ...envelope, kind: d.kind, port: d.port }
  // The key has to be there: the schema admits any value under it, not its absence.
  if (d.kind === 'message' && 'message' in d)
    return { ...envelope, kind: 'message', port: d.port, message: d.message }
  return null
}

/** A message on this channel from the page itself, as far as the relay needs to know. */
function fromPage(event: { source: unknown; origin: string; data: unknown }, win: PageWindow) {
  if (event.source !== win || event.origin !== win.location.origin) return null
  return readPageEnvelope(event.data)
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
      post({
        kind: 'hello',
        version: api.runtime.getManifest().version,
        protocol: BRIDGE_PROTOCOL_VERSION,
      })
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
