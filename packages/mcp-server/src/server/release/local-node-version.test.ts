// The suite is calibrated for the Node in `.node-version`, and running it on
// a different major produces failures that name the wrong thing.
//
// Measured, on Node 22 against a pin of 24: nine `web-jsdom` tests fail, all
// with a message about `Blob`. jsdom's own `Blob` implements `slice`, `text`,
// `arrayBuffer` and `bytes` and NO `stream()` — the same in both majors — so
// what differs is undici's `new Response(blobLike)`, which reaches for
// `.stream()` on 22 and does not on 24. The failure surfaces as
// `TypeError: object.stream is not a function` from deep inside
// `node:internal/deps/undici`, pointing at a Blob the test wrote and at code
// the diff never touched.
//
// A whole session read those nine as "standing environment failures", wrote
// them off in three PR bodies, and A/B-confirmed them against a clean
// `origin/main` — which is true, and answers a different question than "why".
// Nothing anywhere said the checkout was on the wrong Node. That is the gap
// this closes, and it is the same one `local-gate-command.test.ts` closes for
// the gate command: a local result that is trusted and wrong is worse than no
// local result.
//
// `engines` in the published package is deliberately wider (`^22 || ^24 ||
// >=26`) and is not this. That says what a CONSUMER may run the daemon on;
// `.node-version` says what this repo develops and tests on, and CI installs
// exactly it.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { trackedFiles } from '../../shared/test-utils/tracked-files.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')

function pinnedMajor(): string {
  // `.node-version` may carry a bare major ("24"), a full version, or a "v"
  // prefix depending on who wrote it; every reader in the wild takes the
  // leading number, so this does too.
  const raw = readFileSync(join(ROOT, '.node-version'), 'utf8').trim()
  const major = /^v?(\d+)/.exec(raw)?.[1]
  if (major === undefined) throw new Error(`.node-version is not a version: ${JSON.stringify(raw)}`)
  return major
}

describe('the checkout runs the Node the suite is calibrated for', () => {
  it('.node-version names a major', () => {
    // Asserted separately so a malformed pin fails as itself rather than as a
    // mismatch against whatever is running.
    expect(pinnedMajor()).toMatch(/^\d+$/)
  })

  it('is running that major', () => {
    const pinned = pinnedMajor()
    const running = process.versions.node.split('.')[0]
    expect(
      running,
      `This checkout is on Node ${process.versions.node} but .node-version pins ${pinned}, which is what CI installs. ` +
        'Nine web-jsdom tests fail on the wrong major with a message about Blob that names neither Node nor this file — ' +
        'so a run on the wrong major looks like nine real regressions. Switch (nvm/fnm/asdf use ' +
        `${pinned}) and re-run before believing any red. See this file's header for the mechanism.`,
    ).toBe(pinned)
  })
})

// Not environmental: these read files, so they hold on any Node. `.node-version`
// is one fact that was written out four more times — the private root's
// `engines`, two workflow literals and a fallback — and the root's `engines`
// had drifted wider than anything the repo is tested on (`^22 || ^24 || >=26`
// beside a pin of 24), which tells a contributor on 22 that they are
// supported, one `pnpm install` before nine unrelated-looking failures.
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
