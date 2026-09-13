// `stress-changed-tests` re-runs every test file a PR touches, five times in
// fresh processes plus three in-process repeats. It is the repo's
// detection-at-introduction gate, and it earned its keep once already — it
// failed two files that a full single-pass suite had passed.
//
// Its whole result rides on one shell variable. If the diff that collects the
// changed files comes back empty, both stress steps skip on their `!= ''`
// guard and the job reports SUCCESS having run nothing. An empty list is
// legitimate (a PR touching no test file), so nothing about the outcome
// distinguishes "correctly had nothing to do" from "the collection broke".
//
// It broke. `git fetch origin "$BASE_REF" --depth=1` leaves the base ref with
// no reachable ancestry, so `origin/main...HEAD` answered
// `fatal: origin/main...HEAD: no merge base` — on stderr, at the head of a
// pipeline, under `bash -e` with no `pipefail`. The step exited 0, and the job
// was green in 43s with five changed test files unstressed (run 33971406910).
//
// These assertions pin the two properties that make that impossible, rather
// than the wording around them.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')

const ciYaml = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf-8')

// Comments stripped: this job's own comment EXPLAINS the broken form it
// replaced, naming `--depth=1`, and the first version of the scan matched that
// explanation and failed on the fixed workflow. A guard that reads prose is a
// guard that reports on prose.
function job(id: string): string {
  const start = ciYaml.indexOf(`\n  ${id}:`)
  if (start === -1) return ''
  const rest = ciYaml.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/)
  const block = next === -1 ? rest : rest.slice(0, next + 1)
  return block.replace(/^\s*#.*$/gm, '')
}

describe('stress-changed-tests cannot pass by collecting nothing', () => {
  const stress = job('stress-changed-tests')

  it('the job exists and still guards its steps on a non-empty file list', () => {
    expect(stress, 'stress-changed-tests job not found in ci.yml').not.toBe('')
    expect(stress).toContain("steps.changed.outputs.files != ''")
  })

  it('fails the step when the diff command fails, instead of yielding an empty list', () => {
    // The collection assigns from a pipeline, so the exit status is the LAST
    // command's. Without pipefail a failing `git diff` at the head is a pass.
    expect(
      stress,
      'the collect step must set pipefail, or a broken diff reads as "no test files changed"',
    ).toMatch(/set -o pipefail/)
  })

  it('resolves the base without a shallow fetch that destroys the merge base', () => {
    expect(
      stress,
      'a `--depth=1` fetch of the base leaves it with no ancestry, and the three-dot diff then has no merge base',
    ).not.toContain('--depth=1')
    expect(
      stress,
      'on a pull_request merge ref HEAD^1 IS the base tip, so the diff needs no fetch at all',
    ).toContain('git diff --name-only HEAD^1 HEAD')
  })

  it('keeps enough history checked out for HEAD^1 to exist', () => {
    // At depth 1 the merge commit has no parent and the diff fails — which,
    // with pipefail above, is now loud rather than silently empty.
    expect(stress).toMatch(/fetch-depth: (0|2)\b/)
  })
})

// The lane is SPLIT so a browser file never shares a vitest process with a
// node or jsdom one, and the split is expressed as two complementary project
// PATTERNS rather than two lists of project names — a list beside the vitest
// config is the drift this repo keeps paying for.
//
// A pattern has its own failure mode, and it is silent: `--passWithNoTests` is
// on, so a leg whose pattern matches nothing passes in seconds, and a project
// claimed by NEITHER leg is simply never stressed. Both directions are checked
// here against the real project list.
//
// What the browser pattern rests on is that every browser project's NAME ends
// `-browser`. That is a convention, and a convention nothing reads is one that
// breaks quietly — a browser project named `foo-chromium` would be swept into
// the node leg and the split would stop doing its job while both legs stayed
// green. So the names are checked against the CONFIG each one comes from.

const projectConfigs = [
  ...readFileSync(join(ROOT, 'vitest.config.ts'), 'utf-8').matchAll(/'([^']+vitest[^']+)'/g),
].map((m) => m[1] as string)

const projects = projectConfigs.map((config) => {
  const name = /name: '([^']+)'/.exec(readFileSync(join(ROOT, config), 'utf-8'))?.[1]
  if (name === undefined) throw new Error(`no test.name in ${config}`)
  return { config, name }
})

/** vitest's own rule: run if it matches no negated pattern, and — when plain patterns are given — at least one of them. */
function matches(name: string, patterns: readonly string[]): boolean {
  const glob = (p: string): RegExp =>
    new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
  const negated = patterns.filter((p) => p.startsWith('!')).map((p) => glob(p.slice(1)))
  const plain = patterns.filter((p) => !p.startsWith('!')).map(glob)
  if (negated.some((re) => re.test(name))) return false
  return plain.length === 0 || plain.some((re) => re.test(name))
}

describe('the stress lane splits the realms without losing a project', () => {
  const legPatterns = [...job('stress-changed-tests').matchAll(/projects: '([^']+)'/g)].map(
    (m) => m[1] as string,
  )

  it('reads two legs off the workflow, and a plausible project count', () => {
    expect(legPatterns, 'the matrix must declare a pattern per leg').toHaveLength(2)
    // Reached, not assumed: a regex that stops matching would otherwise
    // report every project as unclaimed, which sends the reader to the wrong
    // file entirely.
    expect(projects.length).toBeGreaterThan(20)
  })

  it('claims every project exactly once', () => {
    for (const { name } of projects) {
      const claimedBy = legPatterns.filter((pattern) => matches(name, [pattern]))
      expect(
        claimedBy,
        `${name} is stressed by ${claimedBy.length} legs — every project must be claimed by exactly one`,
      ).toHaveLength(1)
    }
  })

  it('names every browser project so the browser pattern can find it', () => {
    for (const { config, name } of projects) {
      const isBrowser = config.endsWith('vitest.browser.config.ts')
      expect(
        name.endsWith('-browser'),
        `${config} declares '${name}': a browser project's name must end '-browser', or the ` +
          'stress lane sweeps it into the node leg and stops separating the realms',
      ).toBe(isBrowser)
    }
  })
})
