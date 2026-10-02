import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

// A backticked filename in a comment is a POINTER, and a pointer at a file
// that is gone sends the next reader somewhere that does not exist. It is
// invisible to every other rung: the code compiles, the tests pass, and a
// grep for the name finds exactly the comment that is wrong.
//
// `mock-specifiers.test.ts` records the same blind spot one door over — a
// `vi.mock('./x.js')` specifier is a string, not an import, so it keeps
// pointing at a deleted module and mocks nothing. Both are resolved rather
// than grepped, for the same reason.
//
// Measured when this landed: 18 unresolvable names, of which 8 were stale
// pointers and 10 were deliberate. The first probe said 41 — it counted
// suffix patterns (`.browser.test.tsx`), placeholders (`./pages/X.tsx`) and
// files outside its scan roots (`vitest.setup.ts`, at a package root). A
// scan that over-reports reads as thorough, so the exclusions below are
// shape rules rather than an allowlist, and only what survives them is a
// decision somebody has to make.
//
// It reads `.claude/**/*.md` as well, and every line of it rather than the
// comment lines, because that markdown IS the comment: it auto-loads into
// every session, so a pointer that has gone stale there is read aloud to
// whoever opens the repo next. Widening it found 25 more, eleven of them in
// one rule file describing a surface ADR-0029 deleted. The scan stops at
// `.claude/` rather than all markdown on the same ground — `docs/` is read
// when somebody goes looking, not handed over unasked.
//
// Widening needed no new shape rule, which is worth saying because the
// probe that sized the work claimed three. A glob (`*.test.ts`), a brace
// expansion and a backticked sentence are all already excluded by the
// character class below, which admits no `*`, `{` or space: a looser probe
// invented the work, and the guard's own rule answered 25 where the probe
// said 27.
//
// A test-file NAME written without backticks is a pointer too, and it is the
// commonest way one is written: a name in running prose, which the scan above
// never looked at. Ten sat there when this was widened — five with the wrong
// extension or infix (`.test.ts` for `.test.tsx`, a `.browser.` that was never
// in the name), one missing its prefix, three at a file that never existed,
// and one wrapped across a line so only its tail survived. Only `.test.ts(x)`
// is read this way, because an ordinary source file's bare name is prose and
// measured as noise, while a name ending in `.test.ts` is a file or a mistake.
// A leading dot is the suffix-pattern shape and is excluded by shape, like the
// backticked scan's. Resolution is by basename alone, which is also all a bare
// name carries, so a basename existing in ANY directory resolves.
/** Every tracked path, which is what a pointer may name. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\n')
    .filter(Boolean)
}

/**
 * A backticked name is a POINTER only if it could name a file at all.
 *
 * Three shapes are not pointers and are excluded by their shape rather than
 * by name, so a new one of each costs nobody an entry:
 * - a suffix pattern (`.browser.test.tsx`) — prose about a naming convention
 * - a single-letter placeholder (`./pages/X.tsx`) — an illustration
 * - an absolute-looking fragment (`/src/components/Thing.tsx`) — a worked
 *   example of a path transformation, not a path
 */
function isPointer(name: string): boolean {
  if (name.startsWith('/')) return false
  if (name.startsWith('.') && !name.startsWith('./')) return false
  return !/(^|\/)[A-Z]\.tsx?$/.test(name)
}

/**
 * A bare test-file name in prose. Not preceded by anything that makes it a
 * fragment of a longer path or glob, not followed by anything that makes it a
 * longer name (`foo.test.tsx.snap`, `foo.test.ts-ish`) — a sentence's own full
 * stop is fine.
 */
const BARE_TEST_FILE = /(?<![\w./*-])([\w][\w.-]*\.test\.tsx?)(?![\w-]|\.\w)/g

/**
 * A bare source or Markdown file name in a COMMENT, the way a comment names
 * the file it is about without backticks.
 * Fifteen such names pointed at files that no longer exist when this was added,
 * every one invisible to the backticked scan above. Resolved by basename, or by
 * tracked suffix when a directory is written.
 */
const BARE_SOURCE_NAME =
  /(?<![\w./*@`-])([A-Za-z][\w-]*(?:\/[\w.-]+)*\.(?:tsx?|mjs|md))(?![\w-]|\.\w)/g

/**
 * Shapes that are not pointers: an illustration of a path (`path/to/…`), a
 * build output (`dist/…`), and the tail of a name wrapped across two comment
 * lines (a name split after its hyphen or dot), where only the tail survives.
 */
function isBareSourcePointer(name: string, line: string, previous: string): boolean {
  if (/^(path\/to|dist)\//.test(name)) return false
  const tail = /^\s*(?:\/\/|\*|\/\*)\s*([^\s]+)/.exec(line)?.[1]
  return !(tail?.startsWith(name) === true && /[-._]\s*$/.test(previous))
}

/**
 * Names that resolve to nothing AND are meant to. Each says why, because a
 * bare exemption is the omission with a word in front of it.
 */
const DELIBERATE: Record<string, string> = {
  'apps/web/src/lib/keeper-parity.test.ts#src/hooks/useBranches.ts':
    'the comment is about its ABSENCE — it stopped reaching the daemon and the ledger refuses an entry naming a module that no longer does',
  'apps/web/src/lib/provider.ts#provider.capability-reach.test.ts':
    'past tense about a deleted guard — "could never have refused" is the argument for deleting it, and a present-tense pointer would invert it',
  'tools/arch-lint/src/stryker-targets.test.ts#api-contracts/libraries.ts':
    'the comment IS the record that these three names went stale while the score stayed plausible; correcting them destroys what it says',
  'tools/arch-lint/src/stryker-targets.test.ts#routes/canvas-thumbnail.ts': 'same sentence',
  'tools/arch-lint/src/stryker-targets.test.ts#routes/canvas-output-path-error.ts': 'same sentence',
  'tools/arch-lint/src/architecture-map.ts#routes/branches.ts':
    'ADR-0029 retired the branch and the comment says the route no longer exists — debt paid by deletion, recorded',
  'tools/arch-lint/src/architecture-map.ts#routes/document/thumbnails.ts':
    'same sentence: the route went with the version row thumbnail',
  'packages/mcp-server/src/server/store/db/migrations/0011-import-fs-blobs.ts#sweep-imported-fs-blobs.ts':
    "a migration's own text is history and is never rewritten (.claude/rules/vocabulary.md); the sweeper existed when this was written (#858)",

  // Bare names in comments (the scan that reads a name without backticks).
  'apps/web/src/hooks/use-document-file-seams.ts#index.md':
    "a quotation of the OKF spec's own words about generators, not a pointer",
  'packages/canvas-render/src/theme/spatial-theme.ts#viewer-appearance.ts':
    'lists the per-surface resolvers this theme layer replaced; the sentence is the record of what they were',
  'packages/canvas-render/src/theme/spatial-theme.ts#spatial-scene-appearance.ts': 'same list',
  'packages/mcp-server/src/daemon/purge-legacy-trust-file.ts#web-origin-trust-store.ts':
    'names the legacy file this module exists to purge; correcting it would erase the reason',
  // Stale pointers the bare-name scan found in files other lanes owned when
  // it landed; each lane repoints its own, and the entry goes with it.
  'apps/web/src/lib/daemon-auth-fetch.ts#packages/mcp-server/src/shared/api-client.ts':
    'stale (now daemon-client api-client.ts); W7 lane C owns the file, repoint next wave',
  'apps/web/src/lib/document-sync-types.ts#hooks/use-identity-event.ts':
    'stale; W7 lane C owns the file, repoint next wave',
  'packages/daemon-client/src/api-client.ts#daemon-connection-payload.ts':
    'stale; W7 lane C owns the package, repoint next wave',
  'packages/daemon-client/src/api-contracts/index.ts#libraries.ts':
    'stale; W7 lane C owns the package, repoint next wave',
  'packages/mcp-server/src/server/store/document-store.test.ts#ws.ts':
    'stale (the sync routes replaced it); W7 lane A owns the store, repoint next wave',
  // Stale directory-qualified pointers the suffix rule exposed in files other
  // lanes owned when it landed; each is repointed by the lane that owns the
  // file, and the entry goes with it (guarded from both sides below).
  'apps/web/src/pages/DaemonIndexPage.test.tsx#references/extract.ts':
    'stale pointer in an apps/web page test; repoint when that area is next touched, then drop this entry',
  'packages/server-core/src/tools/viewport-set.ts#routes/viewport.ts':
    'stale pointer in a server-core tool; the route is routes/viewport-requests.ts — repoint, then drop this entry',

  // The `.claude/**/*.md` half. Every one of these is a sentence whose
  // SUBJECT is the file's absence — a rule explaining why a surface went.
  // Correcting the name would make each say the opposite of what it says.
  '.claude/rules/package-canvas-render.md#scene-transform.ts':
    "mcp-server's FORMER file, named to say where `layout/translate-scene.ts` came from",
  '.claude/rules/package-canvas-render.md#spatial-scene-appearance.ts':
    'one of the three per-surface resolvers the theme layer deleted; the sentence is the list of what it replaced',
  '.claude/rules/package-canvas-render.md#viewer-appearance.ts': 'same list, canvas-viewer half',
  '.claude/rules/package-canvas-viewer.md#viewer-appearance.ts':
    'the paragraph exists to record that this package stopped owning its own resolver',
  '.claude/rules/tool-arch-lint.md#mcp/session-resolver.ts':
    'moved rather than exempted; the sentence names both the old path and `server/current-workspace.ts` it became',
  '.claude/rules/vocabulary.md#meta.ts':
    'the clause is literally "(since deleted)" — this is why `kind` won over `format`',
}

interface Pointer {
  readonly key: string
  readonly file: string
  readonly name: string
}

/** Whether a name written with a directory matches a tracked suffix, or a bare one a tracked basename. */
function resolvesTo(name: string, tracked: readonly string[], byBasename: ReadonlySet<string>) {
  // A bare name carries only a basename, so that is all it resolves by; a name
  // WITH a directory must match a tracked suffix, or a pointer at the wrong
  // directory resolves because the file exists elsewhere.
  if (name.includes('/')) return tracked.some((path) => path === name || path.endsWith(`/${name}`))
  return byBasename.has(basename(name))
}

/** Every pointer on one line that names a file nothing tracks. */
function unresolvedOnLine(
  line: string,
  previous: string,
  wholeFile: boolean,
  tracked: readonly string[],
  byBasename: ReadonlySet<string>,
): string[] {
  const names: string[] = []
  if (!wholeFile) {
    for (const match of line.matchAll(BARE_SOURCE_NAME)) {
      const name = match[1] ?? ''
      if (isBareSourcePointer(name, line, previous) && !resolvesTo(name, tracked, byBasename)) {
        names.push(name)
      }
    }
  }
  for (const match of line.matchAll(/`([A-Za-z0-9._/-]+\.tsx?)`/g)) {
    const name = match[1] ?? ''
    if (isPointer(name) && !resolvesTo(name, tracked, byBasename)) names.push(name)
  }
  for (const match of line.matchAll(BARE_TEST_FILE)) {
    const name = match[1] ?? ''
    if (!byBasename.has(name)) names.push(name)
  }
  return names
}

function unresolvedPointers(): Pointer[] {
  const tracked = trackedFiles()
  const byBasename = new Set(tracked.map((path) => basename(path)))
  const found: Pointer[] = []
  const seen = new Set<string>()
  const scanned = tracked.filter(
    (path) => /\.tsx?$/.test(path) || (path.startsWith('.claude/') && path.endsWith('.md')),
  )
  for (const file of scanned) {
    const wholeFile = file.endsWith('.md')
    const lines = readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')
    for (const [lineIndex, line] of lines.entries()) {
      if (!wholeFile && !/^\s*(\/\/|\*|\/\*)/.test(line)) continue
      const previous = lines[lineIndex - 1] ?? ''
      for (const name of unresolvedOnLine(line, previous, wholeFile, tracked, byBasename)) {
        const key = `${file}#${name}`
        if (seen.has(key)) continue
        seen.add(key)
        found.push({ key, file, name })
      }
    }
  }
  return found
}

const UNRESOLVED = unresolvedPointers()

describe('a filename in a comment, backticked or a bare test file, names a file that exists', () => {
  it('read a plausible number of comment pointers', () => {
    // This half is the SCAN: an `ls-files` that answered nothing would report
    // every pointer as resolving, which is the same shape as a clean tree.
    //
    // It is not the regex canary, though it said so until measured. Replacing
    // the pointer regex with one that matches nothing leaves this case GREEN
    // and fails 'holds no exemption for a pointer that now resolves' — every
    // DELIBERATE key goes obsolete at once, which is the louder signal
    // anyway. Left where it landed rather than moved, because the comment was
    // the defect, not the placement.
    const tracked = trackedFiles()
    expect(tracked.length).toBeGreaterThan(1000)
    expect(UNRESOLVED.length).toBeLessThan(40)
  })

  it('has no pointer at a file that is gone', () => {
    const stale = UNRESOLVED.filter((pointer) => !(pointer.key in DELIBERATE)).map(
      (pointer) => `${pointer.file}: \`${pointer.name}\` resolves to nothing`,
    )

    expect(stale).toEqual([])
  })

  it('holds no exemption for a pointer that now resolves', () => {
    const live = new Set(UNRESOLVED.map((pointer) => pointer.key))
    const obsolete = Object.keys(DELIBERATE).filter((key) => !live.has(key))

    expect(obsolete).toEqual([])
  })
})

// The pointer scan above resolves a backticked FILE NAME by basename, which is
// all a bare name carries. A repo-rooted path carries more, and that is the
// shape the rules and skills write when they send a session somewhere to work:
// `scripts/smoke/mcp-e2e-smoke.mjs` read as a root path, and the file lives at
// `packages/mcp-server/scripts/smoke/…`; a rooted path into an mcp-server
// directory that never existed was named as where response contracts live.
// Both resolved by basename or by nothing, so
// no rung noticed, and the next session searched the root for a file that is
// not there. Here a path starting at a top-level directory must resolve EXACTLY
// — a tracked file, or a directory some tracked file sits under.
//
// A package-relative shorthand is not accepted by rule: the rule files are
// path-scoped, but a skill is read from anywhere, and a path that only means
// something from inside one package is what produced the defect. The few
// entries below are not shorthand at all — an MCP method, a per-machine file,
// an illustrative name.
const REPO_ROOTED_PATH =
  /`((?:packages|apps|tools|docs|\.claude|scripts|tests)\/[A-Za-z0-9._/@-]+)`/g

/** Matches that name no tracked path and are meant to. Guarded from both sides. */
const NOT_A_TRACKED_PATH: Record<string, string> = {
  'tools/list': 'the MCP method name, not a directory',
  'tools/call': 'the MCP method name, not a directory',
  'packages/mcp-server/_artifacts/npm-sbom.cdx.json':
    'a release build output, gitignored by design (docs/contributing/releasing.md)',
  'packages/mcp-server/_artifacts/npm-sbom.inputs.json': 'same build output',
  'packages/canvas-render/tmp/vitest-traces':
    'where a failing browser test writes its trace; gitignored',
  'packages/canvas-viewer/tmp/vitest-traces': 'same trace directory, canvas-viewer half',
  'apps/web/tmp/vitest-traces': 'same trace directory, apps/web half',
  'apps/web/dist/': 'the web build output, gitignored by design',
  '.claude/settings.local.json': 'per-machine and gitignored by design (.gitignore)',
  '.claude/worktrees/':
    'per-machine and gitignored by design — where `new-worktree.mjs` puts a lane',
  '.claude/agents/foo.md':
    'an illustration of an agent file a session might add, from the workflow-authoring skill',
}

interface RootedPath {
  readonly file: string
  readonly path: string
}

function repoRootedPaths(): RootedPath[] {
  const found: RootedPath[] = []
  for (const file of trackedFiles()) {
    // The contributor docs are read from the README onward and name the same
    // paths the rules do, so they rot the same way. `adr/` is history and is
    // a subdirectory, which the anchored pattern leaves out.
    const inScope =
      file === 'AGENTS.md' ||
      file === 'CONTRIBUTING.md' ||
      /^docs\/contributing\/[^/]+\.md$/.test(file) ||
      (/^\.claude\/(rules|skills)\//.test(file) && file.endsWith('.md'))
    if (!inScope) continue
    for (const match of readFileSync(join(REPO_ROOT, file), 'utf8').matchAll(REPO_ROOTED_PATH)) {
      found.push({ file, path: match[1] ?? '' })
    }
  }
  return found
}

function resolvesExactly(path: string, tracked: readonly string[]): boolean {
  const bare = path.replace(/\/$/, '')
  return tracked.some((entry) => entry === bare || entry.startsWith(`${bare}/`))
}

describe('a repo-rooted path in AGENTS.md, a contributor doc, a rule or a skill names something tracked', () => {
  const tracked = trackedFiles()
  const rooted = repoRootedPaths()

  it('read a plausible number of rooted paths', () => {
    // 301 when written. A scan whose regex or scope silently matched nothing
    // reports every path as resolving, which reads like a clean tree.
    expect(rooted.length).toBeGreaterThan(250)
  })

  it('has no path that resolves to nothing', () => {
    const stale = rooted
      .filter(({ path }) => !resolvesExactly(path, tracked) && !(path in NOT_A_TRACKED_PATH))
      .map(({ file, path }) => `${file}: \`${path}\` is not a tracked file or directory`)
    expect(stale).toEqual([])
  })

  it('holds no exemption for a path that resolves now or is no longer written', () => {
    const written = new Set(rooted.map(({ path }) => path))
    const obsolete = Object.keys(NOT_A_TRACKED_PATH).filter(
      (path) => !written.has(path) || resolvesExactly(path, tracked),
    )
    expect(obsolete).toEqual([])
  })
})

// Where a flake shape is DESCRIBED moved once already, and every comment that
// said "integrator-flow.md's ninth shape" went on pointing at a rule file that
// no longer held the shape — and an ordinal, besides, that `flake-shapes.md`
// never kept in order. Those pointers resolve (the file exists), so the
// scans above cannot see them. A shape is cited by its NAME, the `###` heading
// of the taxonomy, and the rule file is only cited for what it still carries.
const FLAKE_SHAPES = '.claude/skills/steward/reference/flake-shapes.md'
const SOURCE_FILE = /\.(tsx?|mjs|cjs|js|jsonc?|ya?ml|grit)$/

/** A comment wrapped across lines, joined so a citation split by a wrap still reads whole. */
function unwrapped(text: string): string {
  return text.replace(/\s*\n\s*(?:\/\/|\*|#)?\s*/g, ' ')
}

/**
 * Non-Markdown files whose mention of the rule file is ABOUT a rule the file
 * does carry (the second-occurrence promotion, the post-merge mechanics), not
 * a pointer at a shape. Each says so; guarded from both sides below.
 */
const RULE_FILE_FLAKE_MENTIONS: Record<string, string> = {
  '.claude/scripts/flake-watch-lib.mjs':
    'the second-occurrence rule, which integrator-flow.md carries',
  '.claude/scripts/flake-watch-lib.test.mjs': 'the same second-occurrence rule',
}

const RULE_FILE_FLAKE_CITATION = /integrator-flow\.md.{0,60}(?:shape|flake)/

function nonMarkdownFlakeCitations(): string[] {
  const hits: string[] = []
  for (const file of trackedFiles()) {
    if (!SOURCE_FILE.test(file) || file === 'tools/arch-lint/src/comment-file-pointers.test.ts') {
      continue
    }
    const text = unwrapped(readFileSync(join(REPO_ROOT, file), 'utf8'))
    if (RULE_FILE_FLAKE_CITATION.test(text)) hits.push(file)
  }
  return hits
}

describe('a flake shape is cited by the name of its heading in flake-shapes.md', () => {
  const taxonomy = readFileSync(join(REPO_ROOT, FLAKE_SHAPES), 'utf8')
  const names = [...taxonomy.matchAll(/^### ([a-z][a-z-]+)$/gm)].map((m) => m[1] ?? '')

  it('read the taxonomy', () => {
    // Fourteen when written. Fewer means the heading shape changed under the
    // scan, which reads as every citation below resolving to nothing.
    expect(names.length).toBeGreaterThanOrEqual(14)
  })

  it('has no comment that sends a reader to the rule file for a flake shape', () => {
    const cited = nonMarkdownFlakeCitations().filter((file) => !(file in RULE_FILE_FLAKE_MENTIONS))
    expect(cited).toEqual([])
  })

  it('holds no exemption for a file that no longer cites the rule file that way', () => {
    const live = new Set(nonMarkdownFlakeCitations())
    expect(Object.keys(RULE_FILE_FLAKE_MENTIONS).filter((file) => !live.has(file))).toEqual([])
  })

  it('names, wherever a comment cites flake-shapes.md by name, a shape that exists', () => {
    const unknown: string[] = []
    let citations = 0
    for (const file of trackedFiles()) {
      if (!SOURCE_FILE.test(file) || file === 'tools/arch-lint/src/comment-file-pointers.test.ts') {
        continue
      }
      const text = unwrapped(readFileSync(join(REPO_ROOT, file), 'utf8'))
      for (const match of text.matchAll(/flake-shapes\.md['’]s `([a-z][a-z-]+)`/g)) {
        citations += 1
        if (!names.includes(match[1] ?? '')) unknown.push(`${file}: \`${match[1]}\``)
      }
    }
    // The subject is present: a citation regex that matched nothing reports
    // every name as resolving.
    expect(citations).toBeGreaterThan(10)
    expect(unknown).toEqual([])
  })
})
