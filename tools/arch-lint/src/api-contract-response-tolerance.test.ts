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
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, stripCommentsAndStrings, walkSourceFiles } from './source-scan.js'

const CONTRACTS_DIR = join(REPO_ROOT, 'packages', 'daemon-client', 'src', 'api-contracts')

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
    const code = stripCommentsAndStrings(readFileSync(path, 'utf-8'))
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
})
