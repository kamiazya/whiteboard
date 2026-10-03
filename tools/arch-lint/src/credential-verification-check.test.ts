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
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { countNamedUses } from './named-use-scan.js'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

/** The daemon. Server-core mounts no credential check of its own. */
const SCAN_DIR = 'packages/mcp-server/src'

/**
 * Each primitive is the last step of "is this secret genuine" for one
 * credential kind. A USE counts, read off the syntax tree so an aliased import
 * (`import { isAuthorized as ok }`) and a call inside a template substitution
 * are seen; an import or a re-export of the name checks nothing, and a scan
 * that cries wolf is a scan people delete.
 */
const PRIMITIVES: readonly { readonly name: string; readonly what: string }[] = [
  { name: 'isAuthorized', what: 'the daemon-token comparison' },
  { name: 'verifyMacaroon', what: "a macaroon's HMAC chain" },
]

/** What a source text does with the primitives: the ones it uses, and the ones it declares. */
function primitivesIn(
  file: string,
  source: string,
): { readonly uses: string[]; readonly declares: string[] } {
  const declared = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      declared.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true))
  const names = PRIMITIVES.map((p) => p.name)
  return {
    uses: PRIMITIVES.filter((p) => countNamedUses(file, source, [p.name]) > 0).map((p) => p.what),
    declares: names.filter((name) => declared.has(name)),
  }
}

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
}

// `oauth-resource-strategy.ts` is NOT here on purpose: it validates a JWT
// against an external IdP and touches none of these primitives at all. An
// entry for it would be an exemption for something that was never flagged,
// which the staleness check below refuses.

/**
 * A quote inside a regex used to blank everything after it, so this fixture is
 * the shape that regressed — a call after it must stay visible.
 */
const REGEX_BLIND_SPOT_FIXTURE = [
  'const strip = /[\\s,"]/',
  'export function surface() {',
  '  return isAuthorized(header, token)',
  '}',
].join('\n')

function scan(): {
  readonly callers: Map<string, string[]>
  readonly touching: Set<string>
  readonly fileCount: number
} {
  const files: string[] = []
  walkSourceFiles(join(REPO_ROOT, SCAN_DIR), files)
  const callers = new Map<string, string[]>()
  const touching = new Set<string>()
  let fileCount = 0
  for (const file of files) {
    const rel = relative(REPO_ROOT, file).split(sep).join('/')
    if (isTestPath(rel)) continue
    fileCount += 1
    const { uses, declares } = primitivesIn(file, readFileSync(file, 'utf8'))
    if (uses.length > 0) callers.set(rel, uses)
    if (uses.length > 0 || declares.length > 0) touching.add(rel)
  }
  return { callers, touching, fileCount }
}

describe('the scan can see what it claims to scan', () => {
  const usesOf = (source: string): string[] => primitivesIn('surface.ts', source).uses

  it('still finds a call after a regex literal containing a quote', () => {
    expect(usesOf(REGEX_BLIND_SPOT_FIXTURE)).toEqual(['the daemon-token comparison'])
  })

  it.each([
    ['a plain call', 'export const f = () => isAuthorized(h, t)'],
    [
      'an aliased import',
      "import { isAuthorized as ok } from './bearer-token.js'\nexport const f = () => ok(h, t)",
    ],
    [
      'a call inside a template substitution',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is source text
      'export const f = () => `${isAuthorized(h, t)}`',
    ],
    [
      'an aliased destructure',
      'const { isAuthorized: ok } = security\nexport const f = () => ok(h, t)',
    ],
    ['a call through a property', 'export const f = () => security.isAuthorized(h, t)'],
    ['a string key', "export const f = () => security['isAuthorized'](h, t)"],
  ])('finds %s', (_label, source) => {
    expect(usesOf(source)).toEqual(['the daemon-token comparison'])
  })

  it('names the macaroon primitive on its own', () => {
    expect(usesOf('export const f = () => verifyMacaroon({ token })')).toEqual([
      "a macaroon's HMAC chain",
    ])
  })

  it.each([
    ['a string', 'const note = "call isAuthorized(x) somewhere"'],
    ['a comment', "// isAuthorized(x) is the resolver's job\nexport const f = 1"],
    ['an import', "import { isAuthorized } from './bearer-token.js'\nexport const f = 1"],
    ['a re-export', "export { isAuthorized } from './bearer-token.js'"],
  ])('does not take %s for a call', (_label, source) => {
    expect(usesOf(source)).toEqual([])
  })

  it('tells a declaration from a use', () => {
    const { uses, declares } = primitivesIn('bearer-token.ts', 'export function isAuthorized() {}')

    expect(uses).toEqual([])
    expect(declares).toEqual(['isAuthorized'])
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
    const { touching } = scan()
    const stale = Object.keys(ALLOWLIST).filter((file) => !touching.has(file))

    expect(
      stale,
      'An allowlist entry neither calls nor defines a verification primitive any more. Drop the entry — an exemption that outlives what it exempts is how a list stops meaning anything.',
    ).toEqual([])
  })
})
