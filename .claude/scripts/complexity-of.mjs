#!/usr/bin/env node
// Cognitive complexity per function, and how a diff moved it — measured
// without touching the working tree.
//
//   node .claude/scripts/complexity-of.mjs <file>...
//   node .claude/scripts/complexity-of.mjs --base origin/main <file>...
//   node .claude/scripts/complexity-of.mjs --base origin/main --changed
//
// Lints with a ONE-rule config written to a temp dir — threshold 1, no
// plugins, no overrides — so every function in every file is scored, exempt
// or not. Writing it in the tree instead would have a reviewer editing
// `biome.json`, which is how a review lane's change once reached a commit.
// `--base` scores each file as it was at that ref (read with `git show` into
// the same temp dir) and prints the delta. `--changed` takes the TS files the
// diff against `--base` touched. See the review-gate `complexity` criteria.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { argsFrom, compare, formatTable, scoresFrom, thresholdFrom } from './complexity-of-lib.mjs'

// The tree being measured is the caller's, not the one this script sits in:
// a worktree runs its own copy, but a reviewer may run this one against another.
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim()
const { base, changed, files: named } = argsFrom(process.argv.slice(2))
// stderr is dropped: `git show` of a file new in this diff is expected to fail.
const git = (...a) =>
  execFileSync('git', a, { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })

let files = named
if (changed) {
  if (base === null) throw new Error('--changed needs --base <ref>')
  files = git('diff', '--name-only', '--diff-filter=AMR', `${base}...HEAD`)
    .split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
}
if (files.length === 0) {
  process.stdout.write('complexity-of: no files\n')
  process.exit(0)
}

const work = mkdtempSync(join(tmpdir(), 'complexity-of-'))
const scoreFiles = (paths, cwd, sourceOf, displayPath) => {
  if (paths.length === 0) return []
  let out
  try {
    out = execFileSync(
      'pnpm',
      ['exec', 'biome', 'lint', `--config-path=${work}`, '--reporter=json', '--max-diagnostics=none', ...paths],
      { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 },
    )
  } catch (error) {
    // biome exits non-zero when it reports anything, which at threshold 1 is always.
    out = error.stdout
  }
  return scoresFrom(JSON.parse(out), sourceOf, displayPath)
}

try {
  writeFileSync(
    join(work, 'biome.json'),
    JSON.stringify({
      linter: {
        rules: {
          recommended: false,
          complexity: { noExcessiveCognitiveComplexity: { level: 'error', options: { maxAllowedComplexity: 1 } } },
        },
      },
    }),
  )
  const threshold = thresholdFrom(readFileSync(join(ROOT, 'biome.json'), 'utf-8'))
  const present = files.filter((f) => existsSync(join(ROOT, f)))
  const head = scoreFiles(present, ROOT, (p) => readFileSync(join(ROOT, p), 'utf-8'))
  let rows = head
  if (base !== null) {
    const baseDir = join(work, 'base')
    const atBase = []
    for (const f of files) {
      let text
      try {
        text = git('show', `${base}:${f}`)
      } catch {
        continue // new in this diff
      }
      mkdirSync(dirname(join(baseDir, f)), { recursive: true })
      writeFileSync(join(baseDir, f), text)
      atBase.push(join(baseDir, f))
    }
    const baseRows = scoreFiles(
      atBase,
      ROOT,
      (p) => readFileSync(p.startsWith('/') ? p : join(ROOT, p), 'utf-8'),
      (p) => relative(baseDir, p.startsWith('/') ? p : join(ROOT, p)),
    )
    rows = compare(baseRows, head)
  }
  process.stdout.write(`${formatTable(rows, threshold)}\n`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
