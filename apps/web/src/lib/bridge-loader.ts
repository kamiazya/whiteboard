import type { ExtensionHelloReply } from '@kamiazya/whiteboard-daemon-client/extension-bridge'

/**
 * The bridge's entry points for the pages that may never use it: the bridge
 * and its schemas are loaded on the first call rather than with the page.
 */
const loadBridge = () => import('./extension-bridge-fetch.js')

/** The page's bridge as a `fetch`, loaded on the first request it carries. */
export const bridgeFetch: typeof globalThis.fetch = async (input, init) =>
  (await loadBridge()).extensionBridgeFetch(input, init)

/** What the whiteboard extension says of itself, or `null` when it is not there to ask. */
export async function extensionHello(signal?: AbortSignal): Promise<ExtensionHelloReply | null> {
  return (await loadBridge()).extensionHello(undefined, signal)
}
