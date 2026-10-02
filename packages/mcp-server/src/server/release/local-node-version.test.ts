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
// Node 22's ICU carries an older Unicode table than 24's, so the second family
// is `packages/search/src/snippet.test.ts` "honours a Prepend", whose oracle is
// the runtime's own segmenter. The root vitest.config.ts globalSetup
// (`.claude/scripts/node-version-banner.mjs`) prints a banner for both on any
// project, since this guard only runs inside `mcp-node`.
//
// `engines` in the published package is deliberately wider (`^22 || ^24 ||
// >=26`) and is not this. That says what a CONSUMER may run the daemon on;
// `.node-version` says what this repo develops and tests on, and CI installs
// exactly it.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../../shared/test-utils/repo-root.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = repoRoot()

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
        'Nine web-jsdom tests fail on the wrong major with a message about Blob that names neither Node nor this file, ' +
        'and packages/search snippet.test.ts "honours a Prepend" fails on the ICU/Unicode table with a message that names ' +
        'neither — so a run on the wrong major looks like real regressions. Switch (nvm/fnm/asdf use ' +
        `${pinned}) and re-run before believing any red. See this file's header for the mechanism.`,
    ).toBe(pinned)
  })
})
