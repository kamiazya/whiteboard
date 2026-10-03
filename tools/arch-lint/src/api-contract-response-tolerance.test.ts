/**
 * What the browser parses of a daemon's answer must tolerate a field it has
 * not heard of; what the daemon parses of a request stays strict.
 *
 * The hosted app updates itself behind a service worker while the daemon is
 * installed separately, so the two are routinely different versions. A
 * newer daemon adding a field to an answer is the ordinary case, and an
 * older bundle reading it through `.strict()` reports a move that landed as
 * failed or refuses to unlock a replica — the contract turns a compatible
 * addition into an outage. Zod's default object strips what it does not
 * know, which is the behaviour a reader wants. A request is the opposite:
 * the daemon is the one deciding what it accepts, and refusing an
 * undeclared field tells a caller its value did not take effect.
 *
 * Request and answer are told apart by the declaration's name, the one
 * convention these modules already keep: `*RequestSchema` may be strict;
 * anything else in `api-contracts/` — an answer, a refusal, a part of one —
 * may not. A daemon that wants to refuse an undeclared field in what it
 * EMITS applies `.strict()` at the emit site, where the browser never sees it.
 *
 * What this reads is TEXT, so it sees only declarations written in these
 * files. A schema the browser parses can also arrive by `export { x as y }`
 * from another package, or be built from a strict piece declared there; the
 * barrel therefore re-exports no foreign schema by name (below), and
 * `packages/daemon-client/src/api-contracts/answers-tolerant.test.ts` walks
 * the live schema graph of everything published, at any depth.
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, stripCommentsAndStrings, walkSourceFiles } from './source-scan.js'

const CONTRACTS_DIR = join(REPO_ROOT, 'packages', 'daemon-client', 'src', 'api-contracts')
const BARREL = join(CONTRACTS_DIR, 'index.ts')

/**
 * A foreign re-export that is a schema by name but cannot be strict: a lone
 * string pattern has no object to refuse a key. Guarded from both sides
 * below, so an entry cannot outlive the line it excuses.
 */
const FOREIGN_SCHEMA_REEXPORTS: readonly string[] = ['apiErrorCodeSchema']

/** Value exports the barrel takes from another package, by the name the browser sees. */
function foreignSchemaReexports(source: string): string[] {
  const blocks = source.matchAll(/export\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)
  return [...blocks]
    .filter(([, , specifier]) => !specifier?.startsWith('.'))
    .flatMap(([, names]) => (names ?? '').split(','))
    .map(
      (name) =>
        name
          .trim()
          .split(/\s+as\s+/)
          .pop() ?? '',
    )
    .filter((name) => name.endsWith('Schema'))
}

interface Declaration {
  readonly file: string
  readonly name: string
  readonly code: string
}

// Top-level `const`s only (column 0): a helper declared inside a function is
// part of the declaration that holds it.
function declarations(): Declaration[] {
  const found: Declaration[] = []
  for (const path of walkSourceFiles(CONTRACTS_DIR).filter((p) => !isTestPath(p))) {
    if (/\.test-helper\.ts$/.test(path)) continue
    const code = stripCommentsAndStrings(readFileSync(path, 'utf-8'), path)
    const starts = [...code.matchAll(/^(?:export )?const (\w+)\b/gm)]
    starts.forEach((match, i) => {
      const end = starts[i + 1]?.index ?? code.length
      found.push({
        file: relative(REPO_ROOT, path),
        name: match[1] as string,
        code: code.slice(match.index, end),
      })
    })
  }
  return found
}

describe('api-contracts: strict requests, tolerant answers', () => {
  it('scans a real population, with the strict half still present', () => {
    const all = declarations()
    expect(all.filter((d) => d.name.endsWith('ResponseSchema')).length).toBeGreaterThan(20)
    const strictRequests = all.filter(
      (d) => d.name.endsWith('RequestSchema') && d.code.includes('.strict()'),
    )
    expect(strictRequests.length).toBeGreaterThanOrEqual(3)
  })

  it('declares nothing strict except a request', () => {
    const offenders = declarations()
      .filter((d) => d.code.includes('.strict()') && !d.name.endsWith('RequestSchema'))
      .map((d) => `${d.file}: ${d.name}`)
    expect(offenders).toEqual([])
  })

  it("declares every request strict, so a typo or a newer client's field is refused rather than stripped", () => {
    // `.strict()` is what turns "the 200 says it worked" into a refusal for a
    // key the daemon did not read. Nothing is excused today; a request that
    // genuinely cannot be strict (a non-object body) belongs here with its
    // reason.
    const EXCUSED_REQUESTS: readonly string[] = []
    const requests = declarations().filter((d) => d.name.endsWith('RequestSchema'))
    expect(requests.length).toBeGreaterThanOrEqual(10)
    const lax = requests
      .filter((d) => !d.code.includes('.strict()') && !EXCUSED_REQUESTS.includes(d.name))
      .map((d) => `${d.file}: ${d.name}`)
    expect(lax).toEqual([])
    for (const name of EXCUSED_REQUESTS) {
      expect(requests.some((d) => d.name === name && !d.code.includes('.strict()'))).toBe(true)
    }
  })

  it('re-exports no schema from another package, where a strict one would pass for an answer', () => {
    // An alias of a server-core tool output is `.strict()` and reads as
    // tolerant at the import site; the browser-facing answers are derived in
    // `packages/daemon-client/src/api-contracts/v1-answers.ts` instead,
    // where this scan and the live walk can see them.
    const source = readFileSync(BARREL, 'utf-8')
    expect(source).toContain('export')
    expect(foreignSchemaReexports(source)).toEqual([...FOREIGN_SCHEMA_REEXPORTS])
  })

  it('reads the foreign re-exports it judges from the barrel, so an empty list is not a miss', () => {
    // Proves the matcher on a known shape: the alias form this rule exists for.
    expect(
      foreignSchemaReexports(
        "export { fooOutputSchema as fooResponseSchema, x } from '@kamiazya/whiteboard-server-core/contracts'",
      ),
    ).toEqual(['fooResponseSchema'])
    expect(foreignSchemaReexports("export { aSchema } from './local.js'")).toEqual([])
  })
})
