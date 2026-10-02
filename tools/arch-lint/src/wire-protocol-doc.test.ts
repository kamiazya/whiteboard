/**
 * `docs/contributing/architecture/wire-protocol.md` is the page the contributor
 * docs index offers for "live-sync message shapes between daemon and browser".
 * It described a WebSocket and a `doc_update` message for a long while after
 * ADR-0050 retired the socket and no source file held that message at all.
 *
 * What it must say is read off the code rather than remembered: the three
 * endpoints the daemon mounts, the three SSE events `sync-sse-contract.ts`
 * declares, and every text frame type `sync-frames.ts` declares, which are
 * the frames a stream relays.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const PAGE = readFileSync(
  join(REPO_ROOT, 'docs/contributing/architecture/wire-protocol.md'),
  'utf-8',
)
const MESSAGES = readFileSync(join(REPO_ROOT, 'packages/daemon-client/src/sync-frames.ts'), 'utf-8')
const CONTRACT = readFileSync(
  join(REPO_ROOT, 'packages/daemon-client/src/sync-sse-contract.ts'),
  'utf-8',
)
const ROUTE = readFileSync(
  join(REPO_ROOT, 'packages/mcp-server/src/server/routes/sync-sse.ts'),
  'utf-8',
)

/** The `type` of every text frame, server-to-client and client-to-server. */
const frameTypes = [...MESSAGES.matchAll(/type:\s*z\.literal\('([a-z_]+)'\)/g)].map(
  (match) => match[1] as string,
)

/** `syncReadyEventSchema` is the `ready` event, and so on. */
const eventNames = [...CONTRACT.matchAll(/export const sync(\w+)EventSchema\b/g)].map((match) =>
  (match[1] as string).toLowerCase(),
)

const endpoints = [...ROUTE.matchAll(/app\.(get|post)\('(\/api\/sync\/[a-z]+)'/g)].map(
  (match) => `${(match[1] as string).toUpperCase()} ${match[2] as string}`,
)

describe('wire-protocol.md describes the live-sync transport that exists', () => {
  it('reads real declarations, so an empty list is not a clean pass', () => {
    expect(frameTypes).toEqual(
      expect.arrayContaining(['version_created', 'viewport_request', 'client_ready']),
    )
    expect(frameTypes.length).toBeGreaterThanOrEqual(6)
    expect(eventNames).toEqual(['ready', 'update', 'message'])
    expect(endpoints).toEqual([
      'GET /api/sync/stream',
      'POST /api/sync/subscribe',
      'POST /api/sync/message',
    ])
  })

  // Each is held where the page DEFINES it — a list item for a frame, a
  // table row for an event or an endpoint — so a passing mention elsewhere in
  // the prose does not stand in for the entry.
  it.each(frameTypes)('lists the %s text frame', (type) => {
    expect(PAGE).toMatch(new RegExp(`^- \`${type}\``, 'm'))
  })

  it.each(eventNames)('has a table row for the %s event', (event) => {
    expect(PAGE).toContain(`| \`${event}\` |`)
  })

  it.each(endpoints)('has a table row for %s', (endpoint) => {
    expect(PAGE).toContain(`| \`${endpoint}\` |`)
  })

  it('names no message and no transport that is gone', () => {
    expect(PAGE).not.toContain('doc_update')
    expect(PAGE).not.toMatch(/web\s?socket/i)
  })
})
