/**
 * The ADR index's Status column and each record's own `**Status:**` line say
 * the same thing about where the decision stands.
 *
 * Both are prose, and both carry detail the other leaves out, so the
 * comparison is of the part a reader acts on: the lifecycle word the status
 * OPENS with (README's "Status lifecycle" table — Proposed, Accepted,
 * Superseded), and for a superseded record, which ADR superseded it. A
 * record that reads Accepted in its file and Proposed in the index sends a
 * reader to relitigate a decision that was made.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const ADR_DIR = join(REPO_ROOT, 'docs/contributing/adr')
const LIFECYCLE = ['Proposed', 'Accepted', 'Superseded'] as const

/** The lifecycle word a status opens with, and the successor a superseded one names. */
function statusHead(status: string): string {
  const text = status.replace(/\*\*/g, '').trim()
  const word = LIFECYCLE.find((candidate) => text.startsWith(candidate))
  if (word === undefined) return `unknown: ${text.slice(0, 40)}`
  if (word !== 'Superseded') return word
  const successor = /^Superseded by \[?ADR-(\d{4})/.exec(text)?.[1]
  return `Superseded by ADR-${successor ?? '?'}`
}

const files = readdirSync(ADR_DIR).filter((name) => /^\d{4}-.+\.md$/.test(name))

const fileStatus = new Map(
  files.map((name): [string, string] => {
    const line = readFileSync(join(ADR_DIR, name), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('**Status:**'))
    return [name, line === undefined ? 'missing' : statusHead(line.slice('**Status:**'.length))]
  }),
)

const indexRows = readFileSync(join(ADR_DIR, 'README.md'), 'utf8')
  .split('\n')
  .flatMap((row): [string, string][] => {
    const match = /^\| \[ADR-\d{4}\]\(([^)]+)\) \|[^|]*\| (.*) \|$/.exec(row)
    return match === null ? [] : [[match[1] as string, statusHead(match[2] as string)]]
  })

// Kept beside the rows rather than built alone: a Map keeps the LAST row per
// name, so a record listed twice with two statuses would be judged on the one
// that happened to come later.
const indexStatus = new Map(indexRows)

describe('the ADR index agrees with each record about its status', () => {
  it('reads every record and every index row', () => {
    // A parse that matched nothing would agree with everything below.
    expect(files.length).toBeGreaterThan(50)
    const names = indexRows.map(([name]) => name)
    expect(names.length, 'a record is listed once').toBe(new Set(names).size)
    expect([...names].sort()).toEqual([...files].sort())
  })

  it('opens every status with a lifecycle word, in the file and in the index', () => {
    const unknown = [
      ...[...fileStatus].map(([name, head]) => `${name} (file): ${head}`),
      ...[...indexStatus].map(([name, head]) => `${name} (index): ${head}`),
    ].filter((entry) => / (?:unknown|missing)/.test(entry) || entry.endsWith('ADR-?'))
    expect(unknown).toEqual([])
  })

  it('gives each record the same lifecycle status in both places', () => {
    const disagreeing = files
      .filter((name) => fileStatus.get(name) !== indexStatus.get(name))
      .map((name) => `${name}: file ${fileStatus.get(name)}, index ${indexStatus.get(name)}`)
    expect(disagreeing).toEqual([])
  })

  it('reads the lifecycle word and the successor off a status', () => {
    expect(statusHead('Accepted — in effect')).toBe('Accepted')
    expect(statusHead(' **Proposed** — design only')).toBe('Proposed')
    expect(statusHead('Superseded by [ADR-0050](0050-x.md), in effect')).toBe(
      'Superseded by ADR-0050',
    )
    expect(statusHead('Implemented — shipped')).toMatch(/^unknown/)
  })
})
