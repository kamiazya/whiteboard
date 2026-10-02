// The Node pin is one fact that was written out four more times — the private
// root's `engines`, two workflow literals and a fallback — and the root's
// `engines` had drifted wider than anything the repo is tested on (`^22 ||
// ^24 || >=26` beside a pin of 24), which tells a contributor on 22 that they
// are supported, one `pnpm install` before nine unrelated-looking failures.
//
// These read files, so they hold on any Node. Whether the checkout RUNS the
// pinned major is an environment premise, not a scan, and stays beside the
// daemon suite in packages/mcp-server's `release/local-node-version.test.ts`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { trackedFiles } from './tracked-files.js'

const ROOT = REPO_ROOT

function pinnedMajor(): string {
  const raw = readFileSync(join(ROOT, '.node-version'), 'utf8').trim()
  const major = /^v?(\d+)/.exec(raw)?.[1]
  if (major === undefined) throw new Error(`.node-version is not a version: ${JSON.stringify(raw)}`)
  return major
}

describe('every copy of the Node pin agrees with .node-version', () => {
  /** Whether a range of `^N` / `>=N` alternatives admits Node major `major`. */
  function admitsMajor(range: string, major: number): boolean {
    return range.split('||').some((alternative) => {
      const part = alternative.trim()
      const caret = /^\^(\d+)$/.exec(part)?.[1]
      if (caret !== undefined) return Number(caret) === major
      const atLeast = /^>=(\d+)$/.exec(part)?.[1]
      if (atLeast !== undefined) return major >= Number(atLeast)
      throw new Error(`engines.node alternative ${JSON.stringify(part)} is not ^N or >=N`)
    })
  }

  const enginesOf = (path: string): string =>
    (JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as { engines: { node: string } }).engines
      .node

  it('the private root admits the pinned major and nothing older or newer', () => {
    const pinned = Number(pinnedMajor())
    const range = enginesOf('package.json')
    expect(admitsMajor(range, pinned), `${range} must admit Node ${pinned}`).toBe(true)
    // A window rather than the two neighbours: `^22 || ^24 || >=26` admits
    // neither 23 nor 25, and is still wider than anything tested.
    const others = Array.from({ length: 80 }, (_, i) => i + 10).filter((m) => m !== pinned)
    expect(
      others.filter((major) => admitsMajor(range, major)).slice(0, 3),
      `${range} admits majors other than the pinned ${pinned}`,
    ).toEqual([])
  })

  it('the published package stays at least as wide as the root: consumers are not the repo', () => {
    const pinned = Number(pinnedMajor())
    expect(admitsMajor(enginesOf('packages/mcp-server/package.json'), pinned)).toBe(true)
  })

  it('every workflow that cannot read the file spells the same major', () => {
    const files = trackedFiles(ROOT, '.github/*/*.yml', '.github/*/*/*.yml')
    const literals = files.flatMap((path) => {
      const text = readFileSync(join(ROOT, path), 'utf8')
      return [
        ...[...text.matchAll(/node-version:\s*['"]?(\d+)['"]?\s*$/gm)].map((m) => m[1] ?? ''),
        ...[...text.matchAll(/\|\| echo (\d+)\)/g)].map((m) => m[1] ?? ''),
      ].map((value) => ({ path, value }))
    })
    // Reached, not assumed: release.yml alone spells it three times.
    expect(literals.length).toBeGreaterThanOrEqual(4)
    expect(literals.filter(({ value }) => value !== pinnedMajor())).toEqual([])
  })
})
