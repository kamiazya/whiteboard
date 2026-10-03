/**
 * Executable half of `.claude/rules/vocabulary.md`.
 *
 * The rule is a prose one — fix the vocabulary in whatever you touch — and
 * prose is the weakest rung. A word the model has NO use for at all is the
 * part that can be mechanical instead, so it is: once the last `slug` is
 * gone, nothing quietly reintroduces it in a file nobody re-reads.
 *
 * Only words with no legitimate meaning left belong here. `canvas` does not
 * qualify and never will — it is the correct name for the spatial surface
 * and the JSON Canvas format; only its use as the CONTAINER noun is wrong,
 * and telling those apart needs a reader.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath } from './source-scan.js'

/**
 * Every directory whose source this rule governs: both composition roots,
 * every shared-layer package, and the scripts and E2E smokes. Deliberately
 * the whole tree rather than arch-lint's narrower boundary scan — a name is
 * wrong wherever it is read, and a composition root is where most of them
 * live.
 *
 * `scripts` and `tests` are here because leaving them out is what let a real
 * break ship: the E2E smokes kept POSTing `{ slug }` to a route whose schema
 * had become `{ path }`, so `packaged-smoke` failed with
 * `400 path is required` — the one CI job that runs them, and the only thing
 * that noticed. Nothing typechecks a `.mjs` smoke against the contract it
 * calls, which is exactly why a scan has to reach them.
 */
const SCAN_DIRS = [
  'apps/web/src',
  'packages/codec/src',
  'packages/model/src',
  'packages/ports/src',
  'packages/canvas-render/src',
  'packages/canvas-viewer/src',
  'packages/loro-adapter/src',
  'apps/web/scripts',
  'packages/canvas-viewer/scripts',
  'packages/mcp-server/scripts',
  'packages/mcp-server/src',
  'packages/server-core/src',
  'tests',
]

/** Every package's `src`, found rather than listed so a new package is scanned the day it exists. */
const PACKAGE_SRC_DIRS: readonly string[] = readdirSync(join(REPO_ROOT, 'packages'))
  .filter((name) => existsSync(join(REPO_ROOT, 'packages', name, 'src')))
  .map((name) => `packages/${name}/src`)

/**
 * Production source that still says WebSocket / WS, with why. The WebSocket
 * transport is retired (ADR-0050): every page syncs over an SSE stream with
 * POSTs upstream, so a comment calling it live sends the next reader to a
 * transport that is gone. An entry is a file that STATES the retirement (the
 * word is the point) or whose text is sample content.
 */
const WEBSOCKET_WORDING: Readonly<Record<string, string>> = {
  'packages/daemon-client/src/sse-backend.ts': 'says why a page has no WebSocket path',
  'packages/mcp-server/src/server/routes/sync-sse.ts': 'states that the WebSocket is retired',
  'packages/mcp-server/src/server/sync-audience.ts': 'states that the WebSocket is retired',
  'apps/web/src/pages/ServerModeWorkspace.tsx': 'says server mode has no WebSocket',
  'packages/server-core/src/search/search-corpus.ts':
    'sample document text the search tests index; the word is its content',
}

/**
 * Where `browser-local` survives under `packages/*\/src`, with why. The first
 * is a quoted assertion ABOUT the retired word; the second is sample text a
 * search test indexes.
 */
const BROWSER_LOCAL_IN_PACKAGES: Readonly<Record<string, string>> = {
  'packages/mcp-server/src/server/routes/document/promote-workspace.test.ts':
    'pins that the retired keeper id gets no special pass; naming it is the assertion',
  'packages/server-core/src/search/search-corpus.ts':
    'sample document text the search tests index; the word is its content',
}

/**
 * `apps/web`'s root `.ts` files — the vite config and its plugin options — are
 * neither under `src` nor in `scripts`, and their comments are read like any
 * other: one named `BrowserLocalDocumentPage` and `browser-local-backend`
 * after both were renamed. Found rather than listed so a new root file is
 * scanned the day it exists.
 */
const WEB_ROOT_TS_FILES: readonly string[] = readdirSync(join(REPO_ROOT, 'apps/web'))
  .filter((name) => name.endsWith('.ts'))
  .map((name) => `apps/web/${name}`)

/** Test and test-support source: a test may spell what it asserts about. */
function isTestSource(path: string): boolean {
  return isTestPath(path) || /__screenshots__/.test(path)
}

/**
 * A migration is HISTORY: its log key is recorded in the database and every
 * table and column it names is the name as it stood at that point in the
 * log, so it is the one place an old word must survive verbatim.
 *
 * An ADR is history for the same reason: it reports what was decided at its
 * point in the log, so rewriting its words would misreport the decision.
 * `vocabulary.md` says so outright, which is why this is an exclusion rather
 * than a per-file exemption — there is no future ADR that should be caught.
 */
const EXCLUDED_SEGMENTS = ['migrations', 'adr']

/**
 * Files outside `migrations/` that are nonetheless writing history, with the
 * reason each one is. Keep this list tiny — a growing one means the word is
 * not actually retired.
 */
const EXEMPT_FILES: Readonly<Record<string, string>> = {
  // Seeds a pre-0008 database and then runs the real migrator over it, so
  // every column it writes has to be spelled as it stood at 0007. Using the
  // current name here would test a database that never existed.
  'packages/mcp-server/src/server/store/db/migrator.legacy-upgrade.test.ts':
    'writes the schema as it stood at 0007, before the rename',
}

const BANNED = [
  {
    pattern: /slug/i,
    word: 'slug',
    instead: "`path` (a document's place in the workspace) or `segment` (one level of it)",
  },
  // `local` is NOT retired and cannot be: it still means "on this machine
  // rather than remote" (localhost, Local Network Access, mcp-server's
  // `authMode: 'local-daemon'` opposite `'server-mode'`). What IS retired is
  // `local` used for WHERE A WORKSPACE IS KEPT — an axis it never fit, since
  // a daemon is local too. The two names below spelled it that way and meant
  // opposite things while sharing a word, which is as confusable as a pair
  // gets.
  //
  // Every spelling at once — `browser-local`, `browserLocal`, `BrowserLocal`,
  // `BROWSER_LOCAL` — because they are one word wearing four cases, and a
  // guard that caught only the quoted value is what let file names, test ids
  // and comment prose keep saying it while the symbols beside them did not.
  {
    pattern: /browser[-_]?local/i,
    word: 'browser-local (in any casing)',
    instead: "'browser' — the keeper is named by WHO holds the workspace (Browser / Daemon)",
    // Deliberately the whole prose surface, because a hand grep missed a
    // place THREE times in one increment: `browserlocaldocumentpage-…` had no
    // separator to match on, `testing.md` was camel-cased, and the workflow
    // that comments a preview URL on every PR said "Browser-local mode" in a
    // `.yml` nothing scanned. A reader cannot be relied on to spell the
    // search five ways, in five file types, on every future change.
    dirs: [
      'apps/web/src',
      'apps/web/scripts',
      ...WEB_ROOT_TS_FILES,
      'docs',
      '.github',
      '.claude',
      'README.md',
      'apps/web/DESIGN.md',
      // `packages/` was unscanned and held the same word in nine comments: the
      // guard's scope followed where the first rename happened, not where the
      // word was.
      ...PACKAGE_SRC_DIRS,
    ],
    exempt: [
      ...Object.keys(BROWSER_LOCAL_IN_PACKAGES),
      // PERSISTED value under a `.strict()` schema whose loader falls back to
      // defaults on any parse failure: renaming it in place would discard an
      // existing reader's whole settings payload. It moves with a migration.
      'apps/web/src/lib/user-settings-store.ts',
      // Generates `docs/assets/browser-local-list.png`, which ADR-0008 names
      // in its own prose. Renaming the asset would make a decision record
      // false about a file that no longer exists, and rewriting the ADR to
      // match is what vocabulary.md forbids.
      'apps/web/src/docs-snapshots/browser-local-list.docs-snapshot.test.tsx',
      // Renders that same ADR-pinned asset.
      'docs/tutorials/getting-started.md',
      // The rule this test is the executable half of. It is the one file that
      // HAS to spell the retired words, because naming them is how it retires
      // them — the same reason `resolve.test.ts` still writes `[[canvas:…]]`.
      '.claude/rules/vocabulary.md',
    ],
  },
  // The HYPHENATED spelling is deliberately absent from this pattern, and
  // that is the whole point of splitting the daemon half from the browser
  // one. `local-daemon` is still CORRECT in its network sense — mcp-server's
  // `authMode: 'local-daemon'` opposite `'server-mode'`, the
  // `connect-to-local-daemon` how-to, the `config-file-local-daemon` anchor
  // — because a daemon on this machine really is local. Only the identifier
  // casings (`localDaemonBaseUrl`, `LOCAL_DAEMON_*`) ever named the KEEPER,
  // and those are what this claims.
  {
    pattern: /local_?daemon/i,
    word: 'localDaemon / LOCAL_DAEMON (as an identifier)',
    instead: "'daemonBaseUrl' / 'DAEMON_' — the keeper is named by WHO holds the workspace",
    dirs: [
      'apps/web/src',
      'apps/web/scripts',
      ...WEB_ROOT_TS_FILES,
      'docs',
      '.github',
      '.claude',
      'README.md',
      'apps/web/DESIGN.md',
    ],
    exempt: [
      // The v1->v2 settings migration and its tests. They spell the old key
      // because reading a payload written under it is their entire job —
      // the same reason a database migration names the columns as they stood
      // at its point in the log.
      'apps/web/src/lib/user-settings-store.ts',
      'apps/web/src/lib/user-settings-store.test.ts',
      'apps/web/src/lib/user-settings-store.property.test.ts',
      '.claude/rules/vocabulary.md',
    ],
  },
  // The WebSocket transport is retired (ADR-0050). Case-sensitive on purpose:
  // lowercase `ws` is a workspace-id abbreviation all over the tree and
  // `/ws` a reserved path, while the transport was only ever written
  // `WebSocket` or `WS`. Production source only — a test names it to assert
  // it is gone.
  {
    pattern: /\bWebSocket\b|\bWS\b/,
    word: 'WebSocket / WS (as a live transport)',
    instead:
      "'SSE' or 'sync stream' — pages sync over SSE with POSTs upstream (ADR-0050); say 'WebSocket' only to state that it is retired",
    dirs: [...PACKAGE_SRC_DIRS, 'apps/web/src'],
    productionOnly: true,
    exempt: Object.keys(WEBSOCKET_WORDING),
  },
  // The discriminant VALUE, still apps/web-only: in `packages/mcp-server` the
  // same quoted string is the network-sense auth mode and is correct there.
  {
    pattern: /(['"])local-daemon\1/,
    word: "'local-daemon' (as a value)",
    instead: "'daemon'",
    dirs: ['apps/web/src'],
    exempt: [
      'apps/web/src/lib/user-settings-store.ts',
      'apps/web/src/lib/user-settings-store.test.ts',
    ],
  },
  // The keeper was once named by a `dataMode: 'daemon' | 'local'` prop pair —
  // the same retired `local` on the same axis, spelled as a prop. It is
  // `keeper: 'browser' | 'daemon'` now. Scoped to apps/web/src, where the
  // prop lived; `reaches` names files that carried it, so the scan is proven
  // to cover the ground it once failed on.
  {
    pattern: /\bdataMode\b/,
    word: 'dataMode',
    instead: "`keeper` ('browser' | 'daemon') — the keeper is named by WHO holds the workspace",
    dirs: ['apps/web/src'],
    exempt: [],
    reaches: [
      'apps/web/src/components/WorkspaceTopBar.tsx',
      'apps/web/src/lib/browser-versions-backend.ts',
      'apps/web/src/pages/BrowserDocumentPage.tsx',
      'apps/web/src/pages/DocumentPage.tsx',
      'apps/web/src/pages/document-page-model.ts',
    ],
  },
] as const

/**
 * How many times a file's bytes were actually pulled off disk. Four retired
 * words share three scan roots between them, so a per-word walk reads most of
 * the tree several times over; `scannedFileCount` is what that work SHOULD
 * cost. Asserted below, because the difference is not visible in the source
 * and only shows up as a load-dependent timeout on CI.
 */
let fileReadCount = 0
let scannedFileCount = 0
const scannedFilesByWord = new Map<string, Set<string>>()
const lineCache = new Map<string, string[]>()

function linesOf(file: string): string[] {
  const cached = lineCache.get(file)
  if (cached !== undefined) return cached
  fileReadCount += 1
  const lines = readFileSync(file, 'utf-8').split('\n')
  lineCache.set(file, lines)
  return lines
}

/**
 * Throws rather than skipping when a scan root is gone: a silently-missing
 * directory turns this guard into one that passes by scanning nothing, which
 * is the failure mode a rename is most likely to cause.
 */
function listSourceFiles(dir: string): string[] {
  // A scan root may be a single file: `README.md` and `apps/web/DESIGN.md`
  // are prose this word decays in, and neither has a directory of its own.
  if (statSync(dir).isFile()) return [dir]
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    // `.claude/worktrees/` holds whole CHECKOUTS of other branches — the
    // parallel-development flow `.claude/rules/dev-flow.md` prescribes — and
    // it is gitignored per-machine state, not this repo's source. Walking
    // into one scans some other branch's history (and its CHANGELOG, which
    // records every retired word by construction), so the guard fails on
    // what a developer has lying around rather than on what they wrote.
    // Measured: four stale worktrees produced 382 hits, none of them a file
    // in this checkout.
    if (entry.name === 'worktrees' && dir.endsWith('.claude')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDED_SEGMENTS.includes(entry.name)) continue
      files.push(...listSourceFiles(full))
      continue
    }
    if (/\.(ts|tsx|mts|js|mjs|cjs|json|md|ya?ml)$/.test(entry.name)) files.push(full)
  }
  return files
}

/**
 * The scan runs HERE, at module scope, rather than inside each `it`.
 *
 * It is filesystem-bound work whose wall clock is set by how much else the
 * machine is doing: ~255ms with the tree in page cache, 6315ms measured under
 * the full parallel suite — past vitest's 5000ms default. A per-test timeout
 * does not bound module evaluation, so the cost lands in the collection phase
 * where nothing is racing it, the same reason flake-shapes.md's
 * `in-body-dynamic-import` says to hoist a heavy `await import()` out of a test body.
 *
 * It also fixes what the failure SAID. A timed-out `it` named `no source file
 * says "slug"` reports a retired word and a five-second budget in one message,
 * and reads as a vocabulary violation that is not there.
 */
const hitsByWord = BANNED.map((entry) => {
  const { pattern } = entry
  const scanned = new Set<string>()
  scannedFilesByWord.set(entry.word, scanned)
  // A word retired only within one package scans only that package, so the
  // guard never claims coverage it does not have.
  const dirs: readonly string[] = 'dirs' in entry ? entry.dirs : SCAN_DIRS
  // Per-word, never per-file: exempting a file for one retired word must not
  // quietly stop another word being checked in it.
  const exempt: readonly string[] = 'exempt' in entry ? entry.exempt : []
  const productionOnly = 'productionOnly' in entry
  const hits: string[] = []
  for (const dir of dirs) {
    for (const file of listSourceFiles(join(REPO_ROOT, dir))) {
      const relativePath = relative(REPO_ROOT, file).split(sep).join('/')
      if (relativePath in EXEMPT_FILES || exempt.includes(relativePath)) continue
      if (productionOnly && isTestSource(relativePath)) continue
      scannedFileCount += 1
      scanned.add(relativePath)
      for (const [index, line] of linesOf(file).entries()) {
        if (pattern.test(line)) hits.push(`${relativePath}:${index + 1}: ${line.trim()}`)
      }
    }
  }
  return hits
})

describe('retired vocabulary', () => {
  for (const [index, { word, instead }] of BANNED.entries()) {
    it(`no source file says "${word}" — use ${instead}`, () => {
      expect(hitsByWord[index]).toEqual([])
    })
  }

  // An exemption outlives the file's reason to be one unless something checks
  // it: a lane sweeps its comments, the entry stays, and the guard is quietly
  // wider than anyone meant. Each must still hold the word it excuses — per
  // word for the `exempt` arrays, and for SOME word for `EXEMPT_FILES`.
  for (const entry of BANNED) {
    const exempt: readonly string[] = 'exempt' in entry ? entry.exempt : []
    it(`holds no "${entry.word}" exemption for a file that no longer says it`, () => {
      const stale = exempt.filter(
        (path) => !linesOf(join(REPO_ROOT, path)).some((line) => entry.pattern.test(line)),
      )
      expect(stale).toEqual([])
    })
  }

  it('holds no whole-file exemption for a file that says none of the retired words', () => {
    const stale = Object.keys(EXEMPT_FILES).filter(
      (path) =>
        !linesOf(join(REPO_ROOT, path)).some((line) =>
          BANNED.some(({ pattern }) => pattern.test(line)),
        ),
    )
    expect(stale).toEqual([])
  })

  // A word whose entry names files it must reach: the scan covering them is
  // the subject-present half of a guard that otherwise passes on zero hits.
  for (const entry of BANNED) {
    if (!('reaches' in entry)) continue
    it(`the "${entry.word}" scan reaches the files that used to carry it`, () => {
      const scanned = scannedFilesByWord.get(entry.word) ?? new Set<string>()
      expect(entry.reaches.filter((path) => !scanned.has(path))).toEqual([])
    })
  }

  it('scans the packages it claims to', () => {
    // A directory listing that came back short would scan nothing under
    // `packages/` and report it clean.
    expect(PACKAGE_SRC_DIRS.length).toBeGreaterThan(15)
    expect(PACKAGE_SRC_DIRS).toContain('packages/mcp-server/src')
  })

  it('reads each scanned file once, however many words share its directory', () => {
    // Measured with the cache removed: 4826 reads over 2141 distinct files,
    // because `apps/web/src` alone is a scan root for all four words. The
    // redundancy is invisible in the source and shows up only as a
    // load-dependent timeout, so it is pinned rather than left to a reader.
    expect(scannedFileCount).toBeGreaterThan(lineCache.size)
    expect(fileReadCount).toBe(lineCache.size)
  })
})
