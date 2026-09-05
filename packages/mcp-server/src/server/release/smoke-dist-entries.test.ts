// A distribution smoke imports the PACKAGED artifact by path. If that path is
// not a tsup entry, no build produces it and the smoke cannot pass on any
// machine — it fails its own precondition check before reaching the thing it
// tests.
//
// Measured: `packaged-server-mode-backup-restore-smoke.mjs` imports
// `dist/server/server-mode-backup-restore.js`, and tsup emitted only
// `server/backup-restore`. The module's code WAS in dist, inside a hashed
// chunk of cli/index.js, so nothing looked missing — `ls dist/server` after a
// real build is what settled it. The smoke runs on the release path alone, so
// its precondition had never been reached; a release would have failed at
// `check:release-candidate:docker`.
//
// The entry list and the smokes' import paths are two hand-kept halves of one
// contract. This is the guard that makes them agree.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')

/** tsup entry keys, e.g. `server/backup-restore`. */
function tsupEntryKeys(): string[] {
  const config = readFileSync(join(ROOT, 'packages/mcp-server/tsup.config.ts'), 'utf-8')
  const entryBlock = config.slice(config.indexOf('entry: {'), config.indexOf('outDir'))
  return [...entryBlock.matchAll(/'([^']+)':\s*'src\//g)].map((m) => m[1])
}

/** Every `packages/mcp-server/dist/<path>.js` a distribution smoke names. */
function distPathsSmokesImport(): { file: string; entryKey: string }[] {
  const found: { file: string; entryKey: string }[] = []
  const dir = join(ROOT, 'tests/e2e/distribution')
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.mjs')) continue
    const file = join(dir, name)
    // Comments stripped: the smokes explain their own usage in prose, and a
    // path quoted in a usage comment is not an import.
    const source = readFileSync(file, 'utf-8').replace(/^\s*\/\/.*$/gm, '')
    for (const match of source.matchAll(/packages\/mcp-server\/dist\/([\w/-]+)\.js/g)) {
      found.push({ file: file.slice(ROOT.length + 1), entryKey: match[1] })
    }
  }
  return found
}

const entries = tsupEntryKeys()
const imported = distPathsSmokesImport()

describe('every dist path a distribution smoke imports is a tsup entry', () => {
  it('read a plausible entry list', () => {
    // A regex that stops matching reports "every smoke path is missing",
    // which sends the reader to the wrong file entirely.
    expect(entries.length, 'no tsup entries parsed').toBeGreaterThan(5)
    expect(entries).toContain('cli/index')
  })

  it('found the smokes that import from dist', () => {
    expect(imported.length, 'no distribution smoke names a dist path').toBeGreaterThan(0)
  })

  it('emits every path the smokes name', () => {
    const missing = imported
      .filter(({ entryKey }) => !entries.includes(entryKey))
      .map(({ file, entryKey }) => `${file} imports dist/${entryKey}.js, which tsup does not emit`)
    expect(missing).toEqual([])
  })
})
