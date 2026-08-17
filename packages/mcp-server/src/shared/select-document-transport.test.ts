// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { selectDocumentTransport } from './select-document-transport.js'

describe('selectDocumentTransport', () => {
  it('picks sse for a secure page talking to an http daemon', () => {
    // The case this whole transport exists for: a secure context cannot open a
    // ws:// socket at all, so attempting one would fail every time.
    expect(
      selectDocumentTransport({
        pageOrigin: 'https://kamiazya-whiteboard.pages.dev',
        daemonBaseUrl: 'http://127.0.0.1:3099',
      }),
    ).toBe('sse')
  })

  it('picks websocket for the daemon-served page', () => {
    expect(
      selectDocumentTransport({
        pageOrigin: 'http://127.0.0.1:3099',
        daemonBaseUrl: 'http://127.0.0.1:3099',
      }),
    ).toBe('websocket')
  })

  it('picks websocket for a plain-http dev origin talking to an http daemon', () => {
    // Mixed content only applies to a SECURE page. An http dev server can open
    // ws:// freely, and WebSocket stays the better transport where available.
    expect(
      selectDocumentTransport({
        pageOrigin: 'http://localhost:5173',
        daemonBaseUrl: 'http://127.0.0.1:3099',
      }),
    ).toBe('websocket')
  })

  it('picks websocket when both sides are secure', () => {
    // The future hosted/Durable-Object leg: wss:// from an https page is an
    // ordinary same-scheme connection with no mixed-content problem.
    expect(
      selectDocumentTransport({
        pageOrigin: 'https://app.example',
        daemonBaseUrl: 'https://sync.example',
      }),
    ).toBe('websocket')
  })

  it('falls back to sse when the page origin cannot be parsed', () => {
    // An unparseable origin is not a licence to attempt a transport that may be
    // blocked outright; SSE works in strictly more places.
    expect(
      selectDocumentTransport({ pageOrigin: 'not a url', daemonBaseUrl: 'http://127.0.0.1:3099' }),
    ).toBe('sse')
  })

  it('falls back to sse when the daemon base url cannot be parsed', () => {
    // The other half of the same guard: either side failing to parse leaves the
    // mixed-content question unanswerable, and SSE is the answer that works.
    expect(
      selectDocumentTransport({ pageOrigin: 'https://app.example', daemonBaseUrl: 'not a url' }),
    ).toBe('sse')
  })
})
