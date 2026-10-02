/**
 * ADR-0050 decision 1: the extension pairs each page connection with one
 * native host process and passes messages both ways. It reads none of them —
 * the host validates what the page asks for and attaches the daemon's
 * credential — so its own job is to admit only the hosted app.
 * https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
 */
import type {
  ExtensionHello,
  ExtensionHelloReply,
  ExtensionToPage,
} from '@kamiazya/whiteboard-daemon-client/extension-bridge'
import {
  BRIDGE_PROTOCOL_VERSION,
  NATIVE_HOST_NAME,
} from '@kamiazya/whiteboard-daemon-client/extension-names'
import { type AdmittingManifest, admitsOrigin } from './manifest.js'

/** The part of a `runtime.Port` the relay uses. */
export interface Port {
  readonly sender?: { origin?: string; url?: string }
  /** Why the port closed, where Firefox says so; Chromium sets `runtime.lastError`. */
  readonly error?: { message?: string } | null
  readonly onMessage: { addListener(listener: (message: unknown) => void): void }
  readonly onDisconnect: { addListener(listener: () => void): void }
  postMessage(message: unknown): void
  disconnect(): void
}

/** The part of `chrome` (or Firefox's `browser`) the relay uses. */
export interface ExtensionApi {
  runtime: {
    connectNative(application: string): Port
    readonly lastError?: { message?: string }
    getManifest(): { version: string } & AdmittingManifest
    onConnectExternal: { addListener(listener: (port: Port) => void): void }
    /** A connection from this extension's own content script (Firefox). */
    onConnect: { addListener(listener: (port: Port) => void): void }
    onMessageExternal: {
      addListener(
        listener: (
          message: unknown,
          sender: { origin?: string },
          sendResponse: (response: unknown) => void,
        ) => void,
      ): void
    }
  }
}

/** The page a port came from: a page names its origin, a content script its URL. */
function originOf(sender: Port['sender']): string | undefined {
  if (sender?.origin !== undefined) return sender.origin
  try {
    return sender?.url === undefined ? undefined : new URL(sender.url).origin
  } catch {
    return undefined
  }
}

/**
 * By hand, not `extensionHelloSchema.safeParse`: zod in the background
 * script is 140 KB for one two-field check. `relay.test.ts` holds this to
 * the schema.
 */
function isHello(message: unknown): message is ExtensionHello {
  return (
    typeof message === 'object' && message !== null && 'type' in message && message.type === 'hello'
  )
}

export function installRelay(api: ExtensionApi, matches: readonly string[]): void {
  const relay = (page: Port) => {
    if (!admitsOrigin(matches, originOf(page.sender))) {
      page.disconnect()
      return
    }
    const native = api.runtime.connectNative(NATIVE_HOST_NAME)
    native.onMessage.addListener((message) => page.postMessage(message))
    page.onMessage.addListener((message) => native.postMessage(message))
    native.onDisconnect.addListener(() => {
      const message =
        native.error?.message ?? api.runtime.lastError?.message ?? 'the native host closed'
      page.postMessage({ type: 'disconnected', message } satisfies ExtensionToPage)
      page.disconnect()
    })
    page.onDisconnect.addListener(() => native.disconnect())
  }
  api.runtime.onConnectExternal.addListener(relay)
  api.runtime.onConnect.addListener(relay)

  api.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    if (!admitsOrigin(matches, sender.origin)) return
    if (isHello(message)) {
      sendResponse({
        type: 'hello',
        version: api.runtime.getManifest().version,
        protocol: BRIDGE_PROTOCOL_VERSION,
      } satisfies ExtensionHelloReply)
    }
  })
}
