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
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

/**
 * Every directory whose source this rule governs: both composition roots and
 * every shared-layer package. Deliberately the whole tree rather than
 * arch-lint's narrower boundary scan — a name is wrong wherever it is read,
 * and a composition root is where most of them live.
 */
const SCAN_DIRS = [
  'apps/web/src',
  'packages/codec/src',
  'packages/model/src',
  'packages/ports/src',
  'packages/canvas-render/src',
  'packages/canvas-viewer/src',
  'packages/crdt/src',
  'packages/mcp-server/src',
  'packages/server-core/src',
]

/**
 * A migration is HISTORY: its log key is recorded in the database and every
 * table and column it names is the name as it stood at that point in the
 * log, so it is the one place an old word must survive verbatim.
 */
const EXCLUDED_SEGMENTS = ['migrations']

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
] as const

function listSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDED_SEGMENTS.includes(entry.name)) continue
      files.push(...listSourceFiles(full))
      continue
    }
    if (/\.(ts|tsx|json)$/.test(entry.name)) files.push(full)
  }
  return files
}

describe('retired vocabulary', () => {
  for (const { pattern, word, instead } of BANNED) {
    it(`no source file says "${word}" — use ${instead}`, () => {
      const hits: string[] = []
      for (const dir of SCAN_DIRS) {
        for (const file of listSourceFiles(join(REPO_ROOT, dir))) {
          const relativePath = relative(REPO_ROOT, file).split(sep).join('/')
          if (relativePath in EXEMPT_FILES) continue
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
