/**
 * Words for a transport and a flow that no longer exist, kept out of the
 * prose a reader learns the product from.
 *
 * ADR-0050 retired the WebSocket (the live transport is SSE, reached through
 * the browser extension), the pairing flow (the extension is how a page
 * reaches a daemon, with nothing to pair) and the loopback port (the daemon
 * listens on an owner-only socket and no network port at all). Prose kept
 * describing all three — "HTTP / WS" on the architecture diagram and in the
 * README alt text, "a WebSocket session" in the domain model, "every paired
 * browser must pair again" in the backup guide, "the loopback daemon" on the
 * docs index pages — because nothing reads prose against the code.
 * Same family as `vocabulary-check.test.ts`, and for the same reason it is a
 * word list rather than a reader: only phrases with no legitimate present
 * meaning belong here.
 *
 * ADRs are history and stay as written. The server's source comments are out
 * of scope: a note in `routes/sync-sse.ts` that the WebSocket is retired is the
 * reason the code looks as it does, and it names the word to say so. The
 * client half is scanned (see `RETIRED_IN_SOURCE`), because its comments are
 * where the retired credential and socket kept being described as the present:
 * the page holds no token and syncs over `fetch`, so a sentence about a bearer
 * token in the query, an authorized fetch or a `ws://` socket describes a
 * design that is gone.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { trackedFiles } from './tracked-files.js'

const SURFACE = (path: string): boolean =>
  (path.startsWith('docs/') &&
    /\.(md|canvas)$/.test(path) &&
    !path.startsWith('docs/contributing/adr/')) ||
  path === 'README.md' ||
  path === 'apps/web/README.md'

const RETIRED = [
  { name: 'HTTP / WS', pattern: /HTTP\s*\/\s*WS\b/i },
  { name: 'WebSocket session', pattern: /WebSocket(?:\s+or\s+SSE)?\s+session/i },
  {
    name: 'pairing',
    pattern: /\bpairing\b|\bpaired\s+(?:browser|origin|device)s?\b|\bpair\s+again\b/i,
  },
  { name: 'loopback daemon', pattern: /\bloopback\s+(?:daemon|only)\b/i },
] as const

/**
 * Prose that names a retired word because its subject is the absence, never
 * the feature. Each is read for what the sentence says, so rewording the
 * sentence out of the word retires the entry rather than needing it kept.
 */
const SUBJECT_IS_THE_ABSENCE: Readonly<Record<string, string>> = {
  'docs/explanation/security-model.md#pairing':
    'lists what the daemon no longer has: "no consent page, no pairing, no browser Origin to judge"',
  'docs/contributing/development.md#pairing':
    '"reconnects by pinging the daemon through the extension, with no pairing grant to renew"',
  'docs/contributing/testing.md#pairing':
    'says what the read-plane smoke used to check and that ADR-0050 retired it',
  'docs/how-to/self-host-with-docker.md#loopback daemon':
    'server mode, not the daemon: the provided Compose file publishes the container port on the host loopback only',
}

const SOURCE_SURFACE = (path: string): boolean =>
  /\.tsx?$/.test(path) &&
  (path.startsWith('packages/daemon-client/src/') || path.startsWith('apps/web/src/'))

const RETIRED_IN_SOURCE = [
  { name: 'bearer token in the query', pattern: /\bbearer\s+token\s+in\s+the\s+query\b/i },
  { name: 'authorized fetch', pattern: /\bauthorized\s+fetch(?:es)?\b/i },
  { name: 'ws://', pattern: /\bwss?:\/\//i },
] as const

/**
 * Source lines that name a retired word because their subject is the absence
 * or the history of the thing, never the present design. Keyed by file and
 * phrase.
 */
const SOURCE_SUBJECT_IS_THE_ABSENCE: Readonly<Record<string, string>> = {
  'apps/web/src/pages/use-daemon-document-backend.ts#ws://':
    'says why no keeper opens a socket: the bridge carries only a fetch and server mode serves none',
  'apps/web/src/component-reach.test.ts#authorized fetch':
    "recounts what a removed component's own suite covered, to explain how a dead file looked alive",
}

const surface = trackedFiles(REPO_ROOT).filter(SURFACE)
const read = (file: string): string => readFileSync(join(REPO_ROOT, file), 'utf-8')

const found = surface.flatMap((file) =>
  RETIRED.filter(({ pattern }) => pattern.test(read(file))).map(({ name }) => `${file}#${name}`),
)

const sourceFound = trackedFiles(REPO_ROOT)
  .filter(SOURCE_SURFACE)
  .flatMap((file) =>
    RETIRED_IN_SOURCE.filter(({ pattern }) => pattern.test(read(file))).map(
      ({ name }) => `${file}#${name}`,
    ),
  )

describe('prose does not describe the retired transport or the pairing flow', () => {
  it('scans a real prose surface, with the diagram and both READMEs in it', () => {
    expect(surface.length).toBeGreaterThan(30)
    expect(surface).toEqual(
      expect.arrayContaining([
        'README.md',
        'apps/web/README.md',
        'docs/assets/architecture.canvas',
        'docs/explanation/domain-model.md',
      ]),
    )
    expect(surface.some((file) => file.startsWith('docs/contributing/adr/'))).toBe(false)
  })

  it('finds no retired phrase outside the recorded absences', () => {
    expect(found.filter((entry) => !(entry in SUBJECT_IS_THE_ABSENCE))).toEqual([])
  })

  it('holds no exemption for prose that no longer says the word', () => {
    expect(Object.keys(SUBJECT_IS_THE_ABSENCE).filter((entry) => !found.includes(entry))).toEqual(
      [],
    )
    expect(Object.keys(SUBJECT_IS_THE_ABSENCE)).toHaveLength(4)
  })

  it.each([
    ['an arrow label', 'HTTP / WS'],
    ['an alt text', 'via HTTP/WS.'],
    ['a domain-model sentence', 'the WebSocket session all read'],
    ['an operator note', 'every paired browser must pair again'],
    ['an index bullet', 'start the loopback daemon for agent workflows'],
    ['a runtimes line', 'a server you run on your own machine (loopback only)'],
  ])('matches the phrase it exists for: %s', (_where, phrase) => {
    expect(RETIRED.some(({ pattern }) => pattern.test(phrase))).toBe(true)
  })
})

describe('client source does not describe the retired credential or socket', () => {
  it('scans the client half, the daemon fetch and the SSE backend in it', () => {
    const files = trackedFiles(REPO_ROOT).filter(SOURCE_SURFACE)
    expect(files.length).toBeGreaterThan(500)
    expect(files).toEqual(
      expect.arrayContaining([
        'packages/daemon-client/src/sse-backend.ts',
        'apps/web/src/lib/daemon-fetch.ts',
      ]),
    )
  })

  it('finds no retired phrase outside the recorded absences', () => {
    expect(sourceFound.filter((entry) => !(entry in SOURCE_SUBJECT_IS_THE_ABSENCE))).toEqual([])
  })

  it('holds no exemption for source that no longer says the word', () => {
    expect(
      Object.keys(SOURCE_SUBJECT_IS_THE_ABSENCE).filter((entry) => !sourceFound.includes(entry)),
    ).toEqual([])
  })

  it.each([
    ['a header', 'the bearer token in the query string would leak'],
    ['a field doc', 'The wrapped, authorized fetch'],
    ['a plural', 'authorized fetches, object URLs'],
    ['a socket', 'cannot open a `ws://` socket to loopback'],
    ['a secure socket', 'wss://daemon.example'],
  ])('matches the phrase it exists for: %s', (_where, phrase) => {
    expect(RETIRED_IN_SOURCE.some(({ pattern }) => pattern.test(phrase))).toBe(true)
  })
})
