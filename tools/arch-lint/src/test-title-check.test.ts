/**
 * A test title is an identifier, not a label. CI annotations carry
 * `[project] file > suite > case`, `flake-watch.mjs` clusters failures by
 * it, and `-t` filters on it — so two tests with the same full path in one
 * file are one name for two failures, and neither can be told from the
 * other in any of those places.
 *
 * Measured when this was added: two, both copy-paste duplicates of the test
 * above them (identical bodies), in one file. That is the common cause, and
 * a duplicate whose body differs is worse: the second test's failure is
 * reported under a title that describes the first.
 *
 * Keyed on the FULL path (every enclosing `describe` plus the title), read
 * by indentation. The same bare title under two different describes is a
 * different name and is fine — `daemon-api-client.test.ts` says "rejects a
 * malformed response body" once per endpoint, and each is distinct.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listTestFiles, TEST_SCAN_DIRS } from './test-scan-dirs.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

const TITLE = /^(\s*)(it|test|describe)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\3).)*)\3/

export function duplicateTitles(source: string): Array<{ line: number; path: string }> {
  const stack: Array<{ indent: number; title: string }> = []
  const seen = new Set<string>()
  const duplicates: Array<{ line: number; path: string }> = []
  for (const [index, line] of source.split('\n').entries()) {
    const match = TITLE.exec(line)
    if (!match) continue
    const indent = match[1]!.length
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop()
    const path = [...stack.map((frame) => frame.title), match[4]!].join(' > ')
    if (match[2] === 'describe') {
      stack.push({ indent, title: match[4]! })
      continue
    }
    if (seen.has(path)) duplicates.push({ line: index + 1, path })
    else seen.add(path)
  }
  return duplicates
}

describe('duplicate test titles', () => {
  it('scans a real population', () => {
    const all = TEST_SCAN_DIRS.flatMap((dir) => listTestFiles(join(REPO_ROOT, dir)))
    expect(all.length).toBeGreaterThan(900)
  })

  it('keys on the full describe path, so the same title under two describes is distinct (self-test)', () => {
    expect(
      duplicateTitles(
        `describe('a', () => {\n  it('x', () => {})\n})\ndescribe('b', () => {\n  it('x', () => {})\n})`,
      ),
    ).toEqual([])
    expect(
      duplicateTitles(`describe('a', () => {\n  it('x', () => {})\n  it('x', () => {})\n})`),
    ).toEqual([{ line: 3, path: 'a > x' }])
    // Leaving a describe by indentation, and modifiers on the runner.
    expect(
      duplicateTitles(
        `describe('a', () => {\n  describe('b', () => {\n    it('x', () => {})\n  })\n  it.concurrent('x', () => {})\n})\ntest('x', () => {})`,
      ),
    ).toEqual([])
  })

  it('no test file gives two tests the same full path', () => {
    const offenders: string[] = []
    for (const dir of TEST_SCAN_DIRS) {
      for (const file of listTestFiles(join(REPO_ROOT, dir))) {
        const relativePath = relative(REPO_ROOT, file).split(sep).join('/')
        for (const hit of duplicateTitles(readFileSync(file, 'utf-8'))) {
          offenders.push(`${relativePath}:${hit.line}: ${hit.path}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

// Keep the directory walker honest: a scan dir that stops existing reports
// itself as "0 files", which is what a broken scan looks like.
it('every scan dir exists', () => {
  for (const dir of TEST_SCAN_DIRS) {
    expect(readdirSync(join(REPO_ROOT, dir)).length, dir).toBeGreaterThan(0)
  }
})
