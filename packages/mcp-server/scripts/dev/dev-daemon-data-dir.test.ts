/**
 * Every script that starts the daemon for DEVELOPMENT goes through
 * `with-dev-data-dir.mjs`, or says why it does not.
 *
 * The wrapper is what keeps a dev session out of the real `~/.whiteboard`
 * (and gives it this worktree's marker).
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
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../../src/shared/test-utils/repo-root.js'

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
}

describe('dev scripts that start the daemon', () => {
  const starting = Object.entries(scripts).filter(([, command]) => startsTheDaemon(command))

  // Without this, a rename of the entry point leaves every assertion below
  // passing over an empty set — which reads exactly like a clean tree.
  it('reaches the scripts that start it at all', () => {
    expect(starting.map(([name]) => name)).toEqual(
      expect.arrayContaining(['daemon', 'mcp:http:dev']),
    )
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

/**
 * A skill or contributor doc that tells a reader to run a package script that
 * is not there. A dev-daemon script deleted from `package.json` stayed in the
 * smoke skill — the page a session loads on "verify behavior" — because
 * nothing read prose against the script list, and the daemon it started was
 * not the one the registered proxy reaches. ADRs are history and say so in
 * dated notes, so they are not read.
 */
describe('prose that tells a reader to run an mcp-server script', () => {
  const REPO_ROOT = repoRoot()
  // pnpm's own commands, which `pnpm --filter <pkg> <word>` also accepts.
  const PNPM_COMMANDS = new Set([
    'exec',
    'run',
    'add',
    'remove',
    'install',
    'dlx',
    'pack',
    'publish',
  ])

  function markdownUnder(dir: string): string[] {
    return readdirSync(join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? markdownUnder(join(dir, entry.name))
        : entry.name.endsWith('.md')
          ? [join(dir, entry.name)]
          : [],
    )
  }

  const docs = [
    ...markdownUnder('.claude/skills'),
    ...readdirSync(join(REPO_ROOT, 'docs/contributing'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => join('docs/contributing', name)),
    'CONTRIBUTING.md',
  ]

  const named = docs.flatMap((file) =>
    [
      ...readFileSync(join(REPO_ROOT, file), 'utf8').matchAll(
        /pnpm --filter @kamiazya\/whiteboard-mcp +([a-zA-Z][\w:-]*)/g,
      ),
    ].map((match) => ({ file, script: match[1] ?? '' })),
  )

  // A scan over nothing finds no dangling name, which reads as a clean tree.
  it('reaches the skills and docs, and finds scripts they name', () => {
    expect(docs.length).toBeGreaterThan(30)
    expect(named.length).toBeGreaterThanOrEqual(5)
  })

  it('names only scripts that package.json declares', () => {
    const dangling = named
      .filter(({ script }) => !(script in scripts) && !PNPM_COMMANDS.has(script))
      .map(({ file, script }) => `${file}: ${script}`)

    expect(dangling).toEqual([])
  })
})
