/**
 * Every `whiteboard <daemon|server|native-host|search> ...` a user is told to
 * type — in the docs, the README and the hosted app's own copy — parses.
 *
 * Why it exists. The app's "no daemon answered" state said `whiteboard daemon
 * run` while the CLI refused the bare form (exit 64), and four docs said the
 * same. A command shown in prose is a claim nothing re-reads, and the reader
 * meets it after already failing at something else.
 *
 * Each command is fed to the real dispatcher. The runners that parse BEFORE
 * they act are replaced by one that records it was reached, so a command that
 * parses never starts a daemon, a backup or a download; the commands that
 * parse inside their own runner (user administration, the native host's
 * installer) run for real against a scratch data directory and home.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { captureStdio } from '../shared/test-utils/capture-stdio.js'
import { repoRoot } from '../shared/test-utils/repo-root.js'

const reached = vi.hoisted(() => ({ count: 0 }))
const runner = vi.hoisted(() =>
  vi.fn(async () => {
    reached.count += 1
    throw new Error('reached the runner')
  }),
)

vi.mock('./daemon-run.js', () => ({ runDaemonRun: runner }))
vi.mock('./daemon-status.js', () => ({ runDaemonStatus: runner }))
vi.mock('./daemon-doctor.js', () => ({ runDaemonDoctor: runner }))
vi.mock('./daemon-stop.js', () => ({ runDaemonStop: runner }))
vi.mock('./daemon-support-bundle.js', () => ({ runDaemonSupportBundle: runner }))
vi.mock('./daemon-replica-posture.js', () => ({
  runDaemonRotateReplicaKey: runner,
  runDaemonSetReplicaTier: runner,
}))
vi.mock('./server-run.js', () => ({ runServerRun: runner }))
vi.mock('./server-status.js', () => ({ runServerStatus: runner }))
vi.mock('./server-stop.js', () => ({ runServerStop: runner }))
vi.mock('./server-doctor.js', () => ({ runServerDoctor: runner }))
vi.mock('./server-backup.js', () => ({ runServerBackup: runner }))
vi.mock('./server-restore.js', () => ({ runServerRestore: runner }))
vi.mock('./server-support-bundle.js', () => ({ runServerSupportBundle: runner }))
vi.mock('./search-fetch-model.js', () => ({ runSearchFetchModel: runner }))

const { main } = await import('./dispatcher.js')

const ROOT = repoRoot()
const FAMILIES = ['daemon', 'server', 'native-host', 'search']

function* walk(dir: string, accept: (path: string) => boolean): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* walk(path, accept)
    else if (accept(path)) yield path
  }
}

/** The text a command was typed as, with the placeholders a reader fills in made concrete. */
function concrete(command: string): string {
  return command
    .replace(/\[[^\]]*\]/g, '')
    .replace(/<([^>|]*)[^>]*>/g, (_, first: string) => first.trim().replace(/\s+/g, '_'))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Prose names a command it is not asking anyone to type ("run `whiteboard
 * server backup`" — its flags are the next sentence's business), and such a
 * mention is judged only on being a command the CLI has. The one a person
 * types as written is how the daemon is started, so every mention of it is
 * judged as a whole.
 */
const TYPED_BARE = new Set(['daemon run'])

const COMMAND = new RegExp(`(?:^|[\\s(])whiteboard (${FAMILIES.join('|')})\\b(.*)$`)

interface Found {
  where: string
  command: string
  /** A command prose mentions by name only: judged on being one the CLI has. */
  named: boolean
}

/** One line of a code span or block, read as the command it shows (if it shows one). */
function commandIn(text: string, where: string, prose: boolean): Found | undefined {
  const match = COMMAND.exec(text.replace(/\s+#\s.*$/, ''))
  if (match === null) return undefined
  const command = concrete(`${match[1]}${match[2]}`).replace(/\.$/, '')
  // `whiteboard daemon *` names a family, `whiteboard server` alone a noun.
  if (command.includes('*') || !command.includes(' ')) return undefined
  const bare = command.split(' ').length === 2
  return { where, command, named: prose && bare && !TYPED_BARE.has(command) }
}

/** Markdown: code spans and fenced blocks only. Prose around them is not a command. */
function markdownCommands(path: string): Found[] {
  const text = readFileSync(path, 'utf8')
  const rel = relative(ROOT, path)
  return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`/g)].flatMap((match) => {
    const fenced = match[1] !== undefined
    const body = (match[1] ?? match[2] ?? '').replace(/\\\n\s*/g, ' ')
    const line = text.slice(0, match.index).split('\n').length
    return body.split('\n').flatMap((one, i) => {
      const found = commandIn(one, `${rel}:${line + i + (fenced ? 1 : 0)}`, !fenced)
      return found === undefined ? [] : [found]
    })
  })
}

/** The app's copy: what a component renders inside `<code>` or as a string. */
function appCopyCommands(path: string): Found[] {
  const text = readFileSync(path, 'utf8')
  const rel = relative(ROOT, path)
  return [...text.matchAll(/<code>([^<]*)<\/code>|(['"`])(whiteboard [^'"`\n]*)\2/g)].flatMap(
    (match) => {
      const line = text.slice(0, match.index).split('\n').length
      const found = commandIn(match[1] ?? match[3] ?? '', `${rel}:${line}`, false)
      return found === undefined ? [] : [found]
    },
  )
}

const found: Found[] = [
  ...walk(join(ROOT, 'docs'), (path) => path.endsWith('.md') && !path.includes('/adr/')),
  join(ROOT, 'README.md'),
].flatMap(markdownCommands)
const appFound = [...walk(join(ROOT, 'apps/web/src'), (path) => /\.tsx$/.test(path))]
  .filter((path) => !/\.test\.tsx$/.test(path))
  .flatMap(appCopyCommands)

let scratch: string
const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'wb-docs-commands-'))
  mkdirSync(join(scratch, 'home'))
  for (const key of ['HOME', 'USERPROFILE', 'WHITEBOARD_DATA_DIR'] as const) {
    saved[key] = process.env[key]
  }
  process.env.HOME = join(scratch, 'home')
  process.env.USERPROFILE = join(scratch, 'home')
  process.env.WHITEBOARD_DATA_DIR = join(scratch, 'data')
})

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(scratch, { recursive: true, force: true })
})

/** Why the dispatcher refused the command, or undefined when it parsed. */
async function usageErrorOf(command: string): Promise<string | undefined> {
  const argv = command.replace(/^whiteboard /, '').split(' ')
  const { result, stderr } = await captureStdio(() => main(argv).catch(() => 1))
  return result === 64 ? stderr.trim() : undefined
}

const UNKNOWN_COMMAND = /^Unknown (command|[\w-]+ subcommand)/

describe('the commands the docs and the app tell a user to type', () => {
  it('finds the commands it judges', () => {
    // An empty scan agrees with anything; these counts say the walk reached
    // the docs, the README and the app, and each family.
    expect(found.length).toBeGreaterThan(30)
    expect(appFound.length).toBeGreaterThan(0)
    for (const family of FAMILIES) {
      expect(
        [...found, ...appFound].some((one) => one.command.startsWith(`${family} `)),
        family,
      ).toBe(true)
    }
  })

  it('all parse', async () => {
    const refused: string[] = []
    for (const one of [...found, ...appFound]) {
      if (/^native-host run\b/.test(one.command)) continue
      const message = await usageErrorOf(`whiteboard ${one.command}`)
      if (message !== undefined && (!one.named || UNKNOWN_COMMAND.test(message))) {
        refused.push(`${one.where}: whiteboard ${one.command}\n    ${message.split('\n')[0]}`)
      }
    }
    expect(refused, refused.join('\n')).toEqual([])
  }, 120_000)

  it('refuses a command with an unknown subcommand, so the judgement can fail', async () => {
    expect(await usageErrorOf('whiteboard daemon no-such-subcommand --json')).toBeDefined()
    expect(await usageErrorOf('whiteboard daemon status')).toBeDefined()
  })
})
