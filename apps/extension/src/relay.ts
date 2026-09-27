/**
 * ADR-0050 decision 1: the extension pairs each page connection with one
 * native host process and passes messages both ways. It reads none of them —
 * the host validates what the page asks for and attaches the daemon's
 * credential — so its own job is to admit only the hosted app.
 * https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
 */
import { NATIVE_HOST_NAME } from '@kamiazya/whiteboard-daemon-client/extension-names'
import { admitsOrigin } from './manifest.js'

/** The part of a `runtime.Port` the relay uses. */
export interface Port {
  readonly sender?: { origin?: string }
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
    getManifest(): { version: string; externally_connectable?: { matches?: string[] } }
    onConnectExternal: { addListener(listener: (port: Port) => void): void }
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

export function installRelay(api: ExtensionApi, matches: readonly string[]): void {
  api.runtime.onConnectExternal.addListener((page) => {
    if (!admitsOrigin(matches, page.sender?.origin)) {
      page.disconnect()
      return
    }
    const native = api.runtime.connectNative(NATIVE_HOST_NAME)
    native.onMessage.addListener((message) => page.postMessage(message))
    page.onMessage.addListener((message) => native.postMessage(message))
    native.onDisconnect.addListener(() => {
      const message = api.runtime.lastError?.message ?? 'the native host closed'
      page.postMessage({ type: 'disconnected', message })
      page.disconnect()
    })
    page.onDisconnect.addListener(() => native.disconnect())
  })

  api.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    if (!admitsOrigin(matches, sender.origin)) return
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'hello'
    ) {
      sendResponse({ type: 'hello', version: api.runtime.getManifest().version })
    }
  })
}
