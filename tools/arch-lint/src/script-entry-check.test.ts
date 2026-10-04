/**
 * Whether a script was run as the entry module is decided in ONE place,
 * `tools/checks/src/is-run-as-script.mjs`, and this is its executable half.
 *
 * `import.meta.url` is percent-encoded and `process.argv[1]` is a raw path, so
 * comparing them as strings (`file://${process.argv[1]}`, `new URL(import.meta.url).pathname`)
 * is false under any checkout whose path holds a space, `#` or `%`. The script
 * then does nothing and exits 0: a build "succeeds" with nothing copied, a
 * `prepack` gate passes with nothing checked.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isExcludedPath, REPO_ROOT, relativeToRepo, walk } from './scan-roots.js'
import { stripComments } from './strip-comments.js'

const HOME = 'tools/checks/src/is-run-as-script.mjs'

/** The roots that hold plain-Node scripts: package scripts, the smokes, the gates and the dev tooling. */
const SCRIPT_ROOTS = ['apps', 'packages', 'tests', 'tools', '.claude/scripts']
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'tmp', '.git', 'public'])

const scripts = SCRIPT_ROOTS.flatMap((root) =>
  walk(join(REPO_ROOT, root), {
    include: (path) =>
      /\.(mjs|cjs|js)$/.test(path) && !/\.test\.[mc]?js$/.test(path) && !isExcludedPath(path),
    skip: (_path, name) => SKIPPED_DIRS.has(name),
  }),
).map((path) => relativeToRepo(path))

/** The spellings that compare an encoded URL with a raw path. */
const RAW_ENTRY_COMPARISON = [
  /file:\/\/\$\{[^}]*argv/,
  /new URL\(\s*import\.meta\.url\s*\)\.pathname/,
  /new URL\(\s*[`'"]file:\/\/[`'"]?\s*\+?\s*\$?\{?\s*process\.argv/,
]

function hasRawEntryComparison(source: string): boolean {
  const code = stripComments(source)
  return RAW_ENTRY_COMPARISON.some((pattern) => pattern.test(code))
}

// Spelled by concatenation: the fixtures are the very text the scan rejects.
const INTERP = '$' + '{process.argv[1]}'
const FRAGILE_SPELLINGS = [
  `import.meta.url === \`file://${INTERP}\``,
  'process.argv[1] === new URL(import.meta.url).pathname',
  `import.meta.url === new URL(\`file://${INTERP}\`).href`,
]

describe('a script finds out it is the entry module in one place', () => {
  it('reaches the scripts and recognises each fragile spelling when it sees one', () => {
    expect(scripts.length).toBeGreaterThan(60)
    expect(scripts).toContain(HOME)
    for (const spelling of FRAGILE_SPELLINGS) {
      expect(hasRawEntryComparison(`if (${spelling}) {}`), spelling).toBe(true)
    }
    expect(hasRawEntryComparison(`// ${FRAGILE_SPELLINGS[0]}`)).toBe(false)
    expect(hasRawEntryComparison('if (isRunAsScript(import.meta.url)) {}')).toBe(false)
  })

  it('no script compares import.meta.url with a raw process.argv[1]', () => {
    const hits = scripts.filter((rel) =>
      hasRawEntryComparison(readFileSync(join(REPO_ROOT, rel), 'utf8')),
    )
    expect(
      hits,
      `use \`isRunAsScript(import.meta.url)\` from ${HOME}: the string comparison is false under a path that needs URL-encoding, and the script silently does nothing`,
    ).toEqual([])
  })

  it.each([
    'a b',
    'a#b',
    'a%20b',
    'a?b',
  ])('the helper answers true for the entry module under a directory named %j', (name) => {
    const root = mkdtempSync(join(tmpdir(), 'script-entry-'))
    try {
      const dir = join(root, name)
      mkdirSync(dir)
      const probe = join(dir, 'probe.mjs')
      const home = join(REPO_ROOT, HOME)
      writeFileSync(
        probe,
        `import { isRunAsScript } from ${JSON.stringify(home)}\nconsole.log(isRunAsScript(import.meta.url))\n`,
      )
      const result = spawnSync(process.execPath, [probe], { encoding: 'utf8' })
      expect(result.stderr).toBe('')
      expect(result.stdout.trim()).toBe('true')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
