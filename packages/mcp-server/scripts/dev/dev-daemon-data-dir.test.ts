/**
 * Every script that starts the daemon for DEVELOPMENT goes through
 * `with-dev-data-dir.mjs`, or says why it does not.
 *
 * The wrapper is what keeps a dev session out of the real `~/.whiteboard`
 * (and gives it this worktree's port, its allowed origins and its marker).
 * `mcp:http:dev` has always run through it; `dev` — the daemon half of
 * `pnpm dev`, the command `development.md` names first — ran
 * `tsx watch src/server/daemon-entry.ts` directly, so the most obvious way to
 * start this project wrote the contributor's real data dir. That script is
 * gone and the root `dev` runs `mcp:http:dev` instead.
 *
 * A prose rule could not have noticed: the two scripts sat four lines apart
 * and read alike, and `index.ts` already logs where the data landed at
 * `notice` level precisely because misdirected persistence is expensive to
 * spot afterwards. This is the rung above that log.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const scripts: Record<string, string> = JSON.parse(
  readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8'),
).scripts

/**
 * A script that starts the daemon: either it names the entry point, or it
 * names the wrapper whose whole job is spawning that entry point. Matching
 * the entry alone would MISS every wrapped script — leaving a probe that
 * finds only the unwrapped ones and a count that cannot tell an empty tree
 * from a clean one.
 */
function startsTheDaemon(command: string): boolean {
  return command.includes('daemon-entry') || command.includes('with-dev-data-dir.mjs')
}

/**
 * The scripts that start the daemon WITHOUT the wrapper, each with the reason
 * it is right that they do. Guarded from both sides: an entry naming a script
 * that no longer exists, or one that has since been wrapped, fails too.
 */
const UNWRAPPED_ON_PURPOSE: Record<string, string> = {
  daemon:
    'the PACKAGED daemon (`dist/`), which is what an installed copy runs — its data dir is the install’s, not a checkout’s',
  'daemon:dev':
    'the watched daemon the `whiteboard-mcp-smoke` skill names for verifying against the REAL `~/.whiteboard`; which data that flow should see is a decision for the skill, not a detail of this guard',
}

describe('dev scripts that start the daemon', () => {
  const starting = Object.entries(scripts).filter(([, command]) => startsTheDaemon(command))

  // Without this, a rename of the entry point leaves every assertion below
  // passing over an empty set — which reads exactly like a clean tree.
  it('reaches the scripts that start it at all', () => {
    expect(starting.length).toBeGreaterThanOrEqual(3)
  })

  it('routes each one through with-dev-data-dir.mjs, or records why not', () => {
    const unexplained = starting
      .filter(([, command]) => !command.includes('with-dev-data-dir.mjs'))
      .filter(([name]) => !(name in UNWRAPPED_ON_PURPOSE))
      .map(([name, command]) => `${name}: ${command}`)

    expect(unexplained).toEqual([])
  })

  it('holds no exemption for a script that is gone or has since been wrapped', () => {
    const stale = Object.keys(UNWRAPPED_ON_PURPOSE).filter((name) => {
      const command = scripts[name]
      return command === undefined || command.includes('with-dev-data-dir.mjs')
    })

    expect(stale).toEqual([])
  })

  it('has a real reason on every exemption', () => {
    const thin = Object.entries(UNWRAPPED_ON_PURPOSE).filter(
      ([, reason]) => reason.trim().split(/\s+/).length < 6,
    )

    expect(thin).toEqual([])
  })
})
