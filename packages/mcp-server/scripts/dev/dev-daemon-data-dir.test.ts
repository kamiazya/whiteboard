/**
 * Every script that boots a store for DEVELOPMENT goes through a launcher
 * that points it at the checkout's `.dev-data`, or says why it does not.
 *
 * The launcher is what keeps a dev session out of the real `~/.whiteboard`
 * (and gives it this worktree's marker). The daemon is not the only thing
 * that opens a store: the stdio server does too, and an unreleased migration
 * run against the real data dir leaves the installed release refusing to
 * start on it.
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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../../src/shared/test-utils/repo-root.js'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const scripts: Record<string, string> = JSON.parse(
  readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8'),
).scripts

/**
 * The launchers that set `WHITEBOARD_DATA_DIR` to the checkout's `.dev-data`
 * before anything opens a store. Each is read below to prove it still does,
 * so a name on this list cannot stand in for a launcher that stopped.
 */
const DEV_DATA_DIR_LAUNCHERS = [
  'with-dev-data-dir.mjs',
  'run-built-daemon.mjs',
  'run-source-stdio.mjs',
]

/**
 * A script that boots a store: it names an entry that opens one (the daemon's
 * or the stdio server's), or a launcher whose whole job is running one.
 * Matching the entries alone would MISS every launched script — leaving a
 * probe that finds only the unlaunched ones and a count that cannot tell an
 * empty tree from a clean one.
 */
function bootsAStore(command: string): boolean {
  return (
    command.includes('daemon-entry') ||
    command.includes('mcp/stdio.ts') ||
    DEV_DATA_DIR_LAUNCHERS.some((launcher) => command.includes(launcher))
  )
}

function setsTheDevDataDir(launcher: string): boolean {
  const path = resolve(PACKAGE_ROOT, 'scripts/dev', launcher)
  return existsSync(path) && readFileSync(path, 'utf8').includes('resolveDevDataDirEnv(')
}

// Only a launcher that really sets the dir counts as routing a script through
// it, so a listed launcher that stopped names every script it fronts below.
const SETTING_LAUNCHERS = DEV_DATA_DIR_LAUNCHERS.filter(setsTheDevDataDir)

function isLaunched(command: string): boolean {
  return SETTING_LAUNCHERS.some((launcher) => command.includes(launcher))
}

/**
 * The scripts that boot a store WITHOUT a launcher, each with the reason it is
 * right that they do. Guarded from both sides: an entry naming a script that
 * no longer exists, or one that has since been launched, fails too.
 */
const UNWRAPPED_ON_PURPOSE: Record<string, string> = {
  daemon:
    'the PACKAGED daemon (`dist/`), which is what an installed copy runs — its data dir is the install’s, not a checkout’s',
}

describe('dev scripts that boot a store', () => {
  const starting = Object.entries(scripts).filter(([, command]) => bootsAStore(command))

  // Without this, a rename of the entry point leaves every assertion below
  // passing over an empty set — which reads exactly like a clean tree.
  it('reaches the scripts that start it at all', () => {
    expect(starting.map(([name]) => name)).toEqual(
      expect.arrayContaining(['daemon', 'mcp:http:dev', 'mcp:http', 'mcp', 'mcp:inspect:stdio']),
    )
  })

  it('routes each one through a dev-data-dir launcher, or records why not', () => {
    const unexplained = starting
      .filter(([, command]) => !isLaunched(command))
      .filter(([name]) => !(name in UNWRAPPED_ON_PURPOSE))
      .map(([name, command]) => `${name}: ${command}`)

    expect(unexplained).toEqual([])
  })

  it('holds no exemption for a script that is gone or has since been launched', () => {
    const stale = Object.keys(UNWRAPPED_ON_PURPOSE).filter((name) => {
      const command = scripts[name]
      return command === undefined || isLaunched(command)
    })

    expect(stale).toEqual([])
  })

  it('names launchers that each set the dev data dir', () => {
    expect(DEV_DATA_DIR_LAUNCHERS.filter((launcher) => !setsTheDevDataDir(launcher))).toEqual([])
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
