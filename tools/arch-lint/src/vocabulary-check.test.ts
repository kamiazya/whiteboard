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
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

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
      'docs',
      '.github',
      '.claude',
      'README.md',
      'apps/web/DESIGN.md',
    ],
    exempt: [
      // PERSISTED value under a `.strict()` schema whose loader falls back to
      // defaults on any parse failure: renaming it in place would discard an
      // existing reader's whole settings payload. It moves with a migration.
      'apps/web/src/lib/user-settings-store.ts',
      'apps/web/src/lib/user-settings-store.test.ts',
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
      '.claude/rules/vocabulary.md',
    ],
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
] as const

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

describe('retired vocabulary', () => {
  for (const entry of BANNED) {
    const { pattern, word, instead } = entry
    // A word retired only within one package scans only that package, so the
    // guard never claims coverage it does not have.
    const dirs: readonly string[] = 'dirs' in entry ? entry.dirs : SCAN_DIRS
    // Per-word, never per-file: exempting a file for one retired word must
    // not quietly stop another word being checked in it.
    const exempt: readonly string[] = 'exempt' in entry ? entry.exempt : []
    it(`no source file says "${word}" — use ${instead}`, () => {
      const hits: string[] = []
      for (const dir of dirs) {
        for (const file of listSourceFiles(join(REPO_ROOT, dir))) {
          const relativePath = relative(REPO_ROOT, file).split(sep).join('/')
          if (relativePath in EXEMPT_FILES || exempt.includes(relativePath)) continue
          const lines = readFileSync(file, 'utf-8').split('\n')
          for (const [index, line] of lines.entries()) {
            if (pattern.test(line)) hits.push(`${relativePath}:${index + 1}: ${line.trim()}`)
          }
        }
      }
      expect(hits).toEqual([])
    })
  }
})
