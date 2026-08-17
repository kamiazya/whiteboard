/**
 * Which transport can actually reach the daemon from this page.
 *
 * A `ws://` URL is blockable mixed content: a page in a secure context cannot
 * open one, and the loopback exemption that lets `http://127.0.0.1` fetches
 * through does NOT extend to WebSocket. So the hosted https app has no
 * WebSocket path to a local http daemon and must sync over SSE instead.
 *
 * This is a property of the two schemes, not of the daemon's identity, so it is
 * decided rather than discovered — attempting ws:// first would fail on every
 * connection and only delay the fallback.
 */
export type DocumentTransport = 'websocket' | 'sse'

export interface SelectDocumentTransportInput {
  /** `location.origin` of the page holding the connection. */
  pageOrigin: string
  /** Base URL of the daemon being connected to. */
  daemonBaseUrl: string
}

function isSecure(url: string): boolean | null {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return null
  }
}

export function selectDocumentTransport(input: SelectDocumentTransportInput): DocumentTransport {
  const pageSecure = isSecure(input.pageOrigin)
  const daemonSecure = isSecure(input.daemonBaseUrl)
  // An unparseable origin gets the transport that works in strictly more
  // places rather than the one that may be blocked outright.
  if (pageSecure === null || daemonSecure === null) return 'sse'
  return pageSecure && !daemonSecure ? 'sse' : 'websocket'
}
