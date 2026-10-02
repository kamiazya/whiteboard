/**
 * ADR-0050 decision 1: the hosted page reaches the daemon only through the
 * extension, which relays the daemon's existing HTTP API to a native host.
 * These are the messages that cross that bridge, and the page is the side
 * the host must not trust.
 */
import { afterAll, describe, expect, it } from 'vitest'
import {
  bridgeSkew,
  extensionHelloReplySchema,
  extensionToPageSchema,
  hostToPageSchema,
  pageToHostSchema,
  windowFromExtensionSchema,
} from './extension-bridge.js'
import { BRIDGE_PROTOCOL_VERSION, WINDOW_BRIDGE_CHANNEL } from './extension-names.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

const request = (path: string) => ({
  type: 'request',
  id: 'r1',
  method: 'GET',
  path,
  headers: {},
})

describe('pageToHostSchema', () => {
  it('accepts a request for the daemon API, and an abort', () => {
    expect(pageToHostSchema.parse(request('/api/workspaces?limit=2'))).toMatchObject({
      path: '/api/workspaces?limit=2',
    })
    expect(pageToHostSchema.parse({ type: 'abort', id: 'r1' })).toEqual({ type: 'abort', id: 'r1' })
  })

  // The page asks for the API and nothing else: not the MCP endpoint, not a
  // path that only reaches /api/ before the daemon normalises it away.
  it.each([
    '/mcp',
    '/api',
    'api/workspaces',
    '/api/../mcp',
    '/api/%2e%2e/mcp',
    '/api/./x',
    '//evil.example/api/x',
    '/api/x#frag',
    'http://localhost/api/x',
  ])('refuses %s', (path) => {
    expect(pageToHostSchema.safeParse(request(path)).success).toBe(false)
  })

  // Most generated tails are acceptable, so the property is not judging an
  // empty set; afterAll proves it.
  let accepted = 0
  afterAll(() => expect(accepted).toBeGreaterThan(0))

  fcTest.prop([fc.webPath()], withDefaults())(
    'an accepted path is one the URL parser leaves exactly as it is, under /api/',
    (tail) => {
      const path = `/api${tail}`
      const parsed = pageToHostSchema.safeParse(request(path))
      if (!parsed.success) return
      accepted += 1
      const resolved = new URL(path, 'http://localhost')
      expect(`${resolved.pathname}${resolved.search}`).toBe(path)
      expect(resolved.pathname.startsWith('/api/')).toBe(true)
    },
  )
})

describe('hostToPageSchema', () => {
  it('reads a response as head, chunks and an end', () => {
    for (const message of [
      { type: 'head', id: 'r1', status: 200, headers: { 'content-type': 'text/event-stream' } },
      { type: 'chunk', id: 'r1', data: 'aGk=' },
      { type: 'end', id: 'r1' },
      { type: 'error', id: 'r1', reason: 'daemon-unreachable', message: 'no daemon' },
    ]) {
      expect(hostToPageSchema.parse(message)).toEqual(message)
    }
  })
})

describe('extensionToPageSchema', () => {
  it('passes the host through, and adds the extension losing its host', () => {
    expect(extensionToPageSchema.parse({ type: 'end', id: 'r1' })).toEqual({
      type: 'end',
      id: 'r1',
    })
    const closed = { type: 'disconnected', message: 'Specified native messaging host not found.' }
    expect(extensionToPageSchema.parse(closed)).toEqual(closed)
  })
})

describe('hostToPageSchema.error', () => {
  // The reason is only displayed, so a host that names a failure this page has
  // no word for must not make the whole message unreadable.
  it('reads a reason it has no word for as the generic one, keeping the message', () => {
    expect(
      hostToPageSchema.parse({ type: 'error', id: 'r1', reason: 'daemon-too-old', message: 'm' }),
    ).toEqual({ type: 'error', id: 'r1', reason: 'stream-failed', message: 'm' })
  })
})

describe('the extension identity a page checks', () => {
  const same = { version: '1.2.3', protocol: BRIDGE_PROTOCOL_VERSION }

  it('is one shape in the hello reply and in the Firefox window relay', () => {
    expect(extensionHelloReplySchema.parse({ type: 'hello', ...same })).toEqual({
      type: 'hello',
      ...same,
    })
    expect(
      windowFromExtensionSchema.parse({
        channel: WINDOW_BRIDGE_CHANNEL,
        from: 'extension',
        kind: 'hello',
        ...same,
      }),
    ).toMatchObject(same)
  })

  it('finds no skew in an extension that speaks this protocol', () => {
    expect(bridgeSkew(same)).toBeNull()
  })

  it('names both protocols and the remedy when the extension is older', () => {
    expect(bridgeSkew({ version: '0.0.1', protocol: BRIDGE_PROTOCOL_VERSION - 1 })).toMatch(
      new RegExp(
        `0\\.0\\.1.*protocol ${BRIDGE_PROTOCOL_VERSION - 1}.*protocol ${BRIDGE_PROTOCOL_VERSION}.*update the extension`,
      ),
    )
  })

  it('tells a page older than the extension to reload', () => {
    expect(bridgeSkew({ version: '9.9.9', protocol: BRIDGE_PROTOCOL_VERSION + 1 })).toMatch(
      /reload this page/,
    )
  })

  it('reads an extension that sends no protocol as one that predates the check', () => {
    const reply = extensionHelloReplySchema.parse({ type: 'hello', version: '0.0.1' })
    expect(bridgeSkew(reply)).toMatch(/predates the bridge protocol check.*update the extension/)
  })
})
