/**
 * "Strip the comments, then match" is defined once per runtime, and the
 * definition is a token walk rather than a regex.
 *
 * It was written eight times as `source.replace(/\/\*[\s\S]*?\*\//g, '')`
 * followed by one of four `//` patterns. Each reads `//` inside a string as a
 * comment: on `const u = 'https://a.example'; localStorage.setItem('k', u)`
 * the storage guard's variant deleted the call, so a guard meant to see every
 * `localStorage` access answered clean about the one line that made it.
 * `import.meta.glob('./**\/*.ts')` is mangled by all of them.
 *
 * `tools/arch-lint` reads the TypeScript parser (`strip-comments.ts`).
 * `apps/web` and `mcp-server` cannot (a package does not import a tool and
 * neither holds the compiler API), so each carries a dependency-free copy;
 * this holds the two copies byte-identical and equal to the parser's answer
 * over every source file in the repo, which is what makes two
 * implementations one definition.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { isExcludedPath, REPO_ROOT, relativeToRepo, SCAN_ROOTS, walk } from './scan-roots.js'
import { stripComments as parserStripComments } from './strip-comments.js'

const WEB_COPY = 'apps/web/src/test-utils/strip-comments.ts'
const MCP_COPY = 'packages/mcp-server/src/shared/test-utils/strip-comments.ts'
const PARSER_HELPER = 'tools/arch-lint/src/strip-comments.ts'

type Stripper = (source: string) => string

async function loadTokenWalk(): Promise<Stripper> {
  // An absolute specifier: this reads another workspace's file on purpose.
  const loaded = (await import(join(REPO_ROOT, WEB_COPY))) as { stripComments: Stripper }
  return loaded.stripComments
}

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8')
}

/** Every TypeScript source in the scanned trees, including tests. */
function sourceFiles(): string[] {
  return SCAN_ROOTS.flatMap((root) =>
    walk(join(REPO_ROOT, root), {
      include: (path) => /\.tsx?$/.test(path) && !isExcludedPath(path),
      skip: (_path, name) => name === 'node_modules' || name === 'dist',
    }),
  )
}

/** Walked once; both describes only read it. */
const FILES = sourceFiles()

/**
 * The whole-source comparison is split into this many disjoint slices so no
 * single test carries the whole parse: its cost is ~10s quiet and several times
 * that under parallel lanes, against a per-test budget.
 */
const SLICES = 8
/** What SLICES may not fall below: the bound the partition test holds each slice to. */
const MIN_SLICES = 8
const sliceOf = (k: number): string[] => FILES.filter((_, i) => i % SLICES === k)

describe('the two dependency-free copies are one definition', () => {
  let tokenWalk: Stripper

  beforeAll(async () => {
    tokenWalk = await loadTokenWalk()
    // TypeScript's program and scanner cold start is paid here, by the hook,
    // rather than by whichever slice a shuffled run happens to start with.
    parserStripComments('const warm = 1', FILES[0])
  }, 120_000)

  it('are byte-identical', () => {
    expect(read(MCP_COPY)).toBe(read(WEB_COPY))
  })

  it('splits the source files into disjoint slices that lose none', () => {
    const slices = Array.from({ length: SLICES }, (_, k) => sliceOf(k))
    // A tree that stopped resolving would agree with everything.
    expect(FILES.length).toBeGreaterThan(1500)
    expect(slices.reduce((sum, slice) => sum + slice.length, 0)).toBe(FILES.length)
    expect(new Set(slices.flat()).size).toBe(FILES.length)
    // No test covers more than 1/MIN_SLICES of the set.
    expect(Math.max(...slices.map((slice) => slice.length))).toBeLessThanOrEqual(
      Math.ceil(FILES.length / MIN_SLICES),
    )
  })

  it.each([...Array(SLICES).keys()])('answer what the parser answers on source slice %i', (k) => {
    const disagreeing = sliceOf(k)
      .filter((path) => {
        const raw = readFileSync(path, 'utf8')
        return tokenWalk(raw) !== parserStripComments(raw, path)
      })
      .map((path) => relativeToRepo(path))
    expect(disagreeing).toEqual([])
  }, 120_000)

  it.each([
    ["const u = 'https://a.example'; localStorage.setItem('k', u)"],
    ["import.meta.glob('./**/*.ts', { query: '?raw' })"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the probe is a template literal
    ['const t = `${a} // inside ${b}`; // gone\nf()'],
    ["const q = /'/g; // gone\nf()"],
    ['/* one\ntwo */ f() // gone\n'],
  ])('and on the probe %s', async (probe) => {
    const tokenWalk = await loadTokenWalk()
    expect(tokenWalk(probe)).toBe(parserStripComments(probe))
  })
})

/** The regex every hand-rolled copy opened with. */
const BLOCK_COMMENT_REGEX = String.raw`\/\*[\s\S]*?\*\/`

/**
 * Scans that still strip with a regex. Shrink-only, and EMPTY: the last eight
 * copies were moved to the helpers in one pass, so a new file must use a
 * helper rather than earn an entry here.
 */
const REGEX_STRIPPERS: Readonly<Record<string, string>> = {}

describe('no scan strips comments with a regex of its own', () => {
  const scanned = FILES.map((path) => relativeToRepo(path)).filter(
    (rel) => rel !== relativeToRepo(import.meta.filename),
  )
  const holders = scanned.filter((rel) => read(rel).includes(BLOCK_COMMENT_REGEX))

  it('is looking at the tree', () => {
    // With nothing left to find, the premise is held from the other side: the
    // walk still reaches both helper copies, and the probe still matches.
    expect(scanned).toEqual(expect.arrayContaining([WEB_COPY, MCP_COPY]))
    expect(`s.replace(/${BLOCK_COMMENT_REGEX}/g, '')`.includes(BLOCK_COMMENT_REGEX)).toBe(true)
  })

  it('finds the regex nowhere outside the ledger', () => {
    expect(
      holders.filter((rel) => REGEX_STRIPPERS[rel] === undefined),
      `import stripComments from ${WEB_COPY}, ${MCP_COPY} or ${PARSER_HELPER}`,
    ).toEqual([])
  })

  it('has no ledger entry that stopped carrying it', () => {
    expect(Object.keys(REGEX_STRIPPERS).filter((rel) => !holders.includes(rel))).toEqual([])
  })
})
