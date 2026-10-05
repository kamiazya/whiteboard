/**
 * The advice a text bound's refusal ends on — what to do instead of writing
 * past the limit — is worded in `packages/model/src`, beside the bound, as a
 * `*_LIMIT_PHRASE`, and every surface that refuses the bound interpolates it.
 *
 * Written per surface, one bound's advice drifted into three wordings across
 * five sites ("split the content across documents", "split it across
 * documents", and a limit "for one write" beside one "for one document"), and
 * the web app's keeper notice copied the node-text advice word for word.
 *
 * The probes are the advice fragments themselves, case-insensitive, read from
 * shipped code with comments removed — so prose may still discuss them, and a
 * test pinning a refusal's exact words passes for the same reason it cannot
 * drift.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, SCAN_ROOTS } from './scan-roots.js'
import { isShippedPath, walkSourceFiles } from './source-scan.js'
import { stripComments } from './strip-comments.js'

const OWNER_DIR = 'packages/model/src/'

/** Sites that word the advice themselves on purpose, each with why it cannot interpolate a phrase. */
const LEFT_IN_PLACE: Readonly<Record<string, string>> = {
  'apps/web/src/lib/limit-notice.ts':
    "sentence-case notice copy that names no count (a keeper's refusal carries none), so it cannot be the model's lower-case clause, which embeds the count",
}

const ADVICE = /across (?:documents|nodes|replies)|embed that|belongs in a text node/i

const files = SCAN_ROOTS.flatMap((root) => walkSourceFiles(join(REPO_ROOT, root))).filter((path) =>
  isShippedPath(path),
)
const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')
const codeOf = (rel: string) => stripComments(readFileSync(join(REPO_ROOT, rel), 'utf8'))
const rels = files.map(relOf)

describe("a text bound's advice is worded in model, beside the bound", () => {
  it('scans a tree that holds the owner and every ledgered site', () => {
    expect(files.length).toBeGreaterThan(500)
    expect(
      rels.filter((rel) => rel.startsWith(OWNER_DIR) && ADVICE.test(codeOf(rel))).length,
    ).toBeGreaterThanOrEqual(3)
    for (const rel of Object.keys(LEFT_IN_PLACE)) expect(rels).toContain(rel)
  })

  it('reads the advice in either case, and not in a comment', () => {
    expect('split the content across documents').toMatch(ADVICE)
    expect('Split it across nodes, or put it in a markdown document and embed that.').toMatch(
      ADVICE,
    )
    expect(codeOf('tools/arch-lint/src/limit-advice-one-place.test.ts')).toMatch(ADVICE)
    expect(stripComments('// split it across documents\nconst x = 1')).not.toMatch(ADVICE)
  })

  it('no shipped source outside model words it', () => {
    const offenders = rels.filter(
      (rel) =>
        !rel.startsWith(OWNER_DIR) && LEFT_IN_PLACE[rel] === undefined && ADVICE.test(codeOf(rel)),
    )
    expect(
      offenders,
      "interpolate the bound's `*_LIMIT_PHRASE` from @kamiazya/whiteboard-model instead",
    ).toEqual([])
  })

  it('every ledgered site still words it', () => {
    const stale = Object.keys(LEFT_IN_PLACE).filter((rel) => !ADVICE.test(codeOf(rel)))
    expect(stale, 'a site that stopped wording the advice no longer needs its entry').toEqual([])
  })
})
