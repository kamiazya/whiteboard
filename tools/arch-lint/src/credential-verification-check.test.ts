/**
 * A credential is verified in ONE place: `credential-resolver.ts`. This scan
 * is the executable half of that rule.
 *
 * Why it exists, measured rather than argued. The daemon had FIVE auth
 * surfaces — `/api/*`, `/api/runtime/*`, the websocket upgrade, `/mcp`, and
 * server-mode's — each holding its own copy of the credential branches behind
 * OPTIONAL parameters. That shape makes "the composition root forgot this
 * argument" and "this daemon has no such credential" the same call, and it
 * shipped the defect twice in one PR: the macaroon root key reached production
 * with no caller while 39 tests reported the feature working, because every
 * test handed the key to the middleware itself.
 *
 * The prose rule and the dev-loop's `userReach` design field were both in
 * force at the time. Neither caught it. So the rule is mechanical now.
 *
 * What it forbids is a surface CALLING a verification primitive. It does not
 * forbid a surface deciding what a grant may do — that is each surface's own
 * policy (`/api/*` reads the route registry, `/api/runtime/*` additionally
 * requires the read half, `/mcp` admits only full authority) and it
 * deliberately stays where it is.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/** The daemon. Server-core mounts no credential check of its own. */
const SCAN_DIR = 'packages/mcp-server/src'

/**
 * Each primitive is the last step of "is this secret genuine" for one
 * credential kind. `.validate(` is matched only through a `pairingTokens`
 * receiver: `validate` alone is far too common a method name, and a scan that
 * cries wolf is a scan people delete.
 */
const PRIMITIVES: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /\bisAuthorized\s*\(/, what: 'the daemon-token comparison' },
  { pattern: /\bverifyMacaroon\s*\(/, what: "a macaroon's HMAC chain" },
  { pattern: /\.verifyAccessToken\s*\(/, what: 'an OAuth access token' },
  { pattern: /\bpairingTokens\s*\.\s*validate\s*\(/, what: 'an origin-bound pairing token' },
  { pattern: /\bredeemTicket\s*\(/, what: 'a single-use websocket ticket' },
]

/**
 * Where each primitive legitimately appears: the module that DEFINES it, and
 * the resolver that is allowed to call every one. Guarded from both sides —
 * an entry naming a file that no longer calls a primitive fails too, so the
 * list cannot outlive what it exempts.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {
  'packages/mcp-server/src/server/security/credential-resolver.ts':
    'the one place a credential is verified — this is the rule, not an exemption',
  'packages/mcp-server/src/server/security/bearer-token.ts': 'defines isAuthorized',
  'packages/mcp-server/src/server/security/macaroon.ts': 'defines verifyMacaroon',
  'packages/mcp-server/src/server/security/ws-ticket-store.ts': 'defines redeemTicket',
}

// `oauth-authz-transactions.ts` and `oauth-resource-strategy.ts` are NOT here
// on purpose: neither matches. The first declares `verifyAccessToken` with no
// receiver, and the patterns look for `.verifyAccessToken(` — a CALL through a
// store. The second validates a JWT against an external IdP and touches none
// of these primitives at all. An entry for either would be an exemption for
// something that was never flagged, which the staleness check below refuses.

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
}

/** A test may call a primitive directly; the rule is about production wiring. */
function isTest(path: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(path) || path.split(sep).includes('test-utils')
}

/**
 * Comments out and string bodies blanked, so prose naming a primitive is not
 * read as calling one.
 *
 * REGEX LITERALS ARE TRACKED, and that is not defensive: the first version of
 * this scan did not, and `bearer-token.ts` contains `/[\s,"]/`. The `"` inside
 * it opened a string that ran to the next quote far below, blanking the rest
 * of the file — so `isAuthorized`'s own declaration became invisible and the
 * allowlist reported the entry as stale. The failure mode is the dangerous
 * direction: any file with a quote inside a regex would have had its tail
 * silently exempted from the scan.
 *
 * Telling division from a regex needs the previous token. The standard
 * heuristic is enough here: a `/` opens a regex when the last meaningful
 * character was an operator, an opening bracket, or nothing at all.
 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  let lastMeaningful = ''
  const REGEX_MAY_FOLLOW = new Set([
    '',
    '(',
    ',',
    '=',
    ':',
    '[',
    '!',
    '&',
    '|',
    '?',
    '{',
    '}',
    ';',
    '+',
    '-',
    '*',
    '%',
    '<',
    '>',
    '~',
    '^',
  ])
  while (i < source.length) {
    const ch = source[i] as string
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    if (ch === '/' && REGEX_MAY_FOLLOW.has(lastMeaningful)) {
      // A regex literal: consume to the unescaped closing slash, honouring a
      // character class, where an unescaped `/` is literal.
      i += 1
      let inClass = false
      while (i < source.length) {
        const r = source[i] as string
        if (r === '\\') {
          i += 2
          continue
        }
        if (r === '[') inClass = true
        else if (r === ']') inClass = false
        else if (r === '/' && !inClass) break
        else if (r === '\n') break
        i += 1
      }
      i += 1
      lastMeaningful = ')'
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i + 1
      i = start
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') i += 1
        i += 1
      }
      i += 1
      out += `${ch}${ch}`
      lastMeaningful = ch
      continue
    }
    out += ch
    if (!/\s/.test(ch)) lastMeaningful = ch
    i += 1
  }
  return out
}

/**
 * The scan reading its own blind spot. A quote inside a regex used to blank
 * everything after it, so this fixture is the shape that regressed — if
 * regex tracking is dropped, the call below becomes invisible and this fails.
 */
const REGEX_BLIND_SPOT_FIXTURE = [
  'const strip = /[\\s,"]/',
  'export function surface() {',
  '  return isAuthorized(header, token)',
  '}',
].join('\n')

function scan(): { readonly callers: Map<string, string[]>; readonly fileCount: number } {
  const files: string[] = []
  walk(join(REPO_ROOT, SCAN_DIR), files)
  const callers = new Map<string, string[]>()
  let fileCount = 0
  for (const file of files) {
    const rel = relative(REPO_ROOT, file).split(sep).join('/')
    if (isTest(rel)) continue
    fileCount += 1
    const source = stripComments(readFileSync(file, 'utf8'))
    // An import is not a call; the primitive has to be invoked.
    const body = source
      .split('\n')
      .filter((line) => !/^\s*import\b/.test(line))
      .join('\n')
    const hits = PRIMITIVES.filter((p) => p.pattern.test(body)).map((p) => p.what)
    if (hits.length > 0) callers.set(rel, hits)
  }
  return { callers, fileCount }
}

describe('the scan can see what it claims to scan', () => {
  it('still finds a call after a regex literal containing a quote', () => {
    const stripped = stripComments(REGEX_BLIND_SPOT_FIXTURE)

    expect(stripped).toContain('isAuthorized(')
    expect(PRIMITIVES.some((p) => p.pattern.test(stripped))).toBe(true)
  })

  it('still blanks a real string, so prose naming a primitive is not a call', () => {
    const stripped = stripComments('const note = "call isAuthorized(x) somewhere"')

    expect(PRIMITIVES.some((p) => p.pattern.test(stripped))).toBe(false)
  })
})

describe('a credential is verified in one place', () => {
  // A count, because a walk that stops finding files reports itself as
  // "everything is clean" and sends the reader nowhere.
  it('scans a plausible number of production files', () => {
    expect(scan().fileCount).toBeGreaterThan(200)
  })

  it('finds no verification primitive called outside the resolver', () => {
    const offenders = [...scan().callers]
      .filter(([file]) => !(file in ALLOWLIST))
      .map(([file, what]) => `${file}: calls ${what.join(', ')}`)

    expect(
      offenders,
      'A surface is verifying a credential itself. Resolve it through `security/credential-resolver.ts` instead — five surfaces each held their own copy once, and a credential went missing on two of them with nothing red.',
    ).toEqual([])
  })

  it('names nothing that has stopped calling one', () => {
    const { callers } = scan()
    const stale = Object.keys(ALLOWLIST).filter((file) => !callers.has(file))

    expect(
      stale,
      'An allowlist entry no longer calls any verification primitive. Drop the entry — an exemption that outlives what it exempts is how a list stops meaning anything.',
    ).toEqual([])
  })
})
