// Real-process regression for the auto-open-browser feature. Every other
// test on this feature (daemon-run-auto-open.test.ts,
// dispatcher-daemon-run-auto-open.test.ts) stubs `openFn` and/or `isTTY` —
// this file is the one place that boots the ACTUAL compiled dispatcher as a
// child process, with a real terminal, and observes what it does to the
// real OS `open`/`xdg-open` resolution path. Unit tests alone would miss a
// regression in the PATH/argv/exec plumbing between `open()` npm package,
// the CLI dispatcher, and a real terminal — exactly the class of bug this
// suite exists to catch.
//
// TTY guard: `decideAutoOpenBrowser` reads `process.stdout.isTTY`, which
// Node only sets on a real terminal device. A pty is allocated via Python's
// `os.forkpty()` (see scripts/dev/pty-broker.py) because it works
// regardless of whether the parent process itself is attached to a
// terminal — unlike `script(1)`, which requires an already-attached tty
// and fails in a sandboxed test harness. python3 ships by default on the
// macOS and ubuntu-latest images this repo's tests run on; the suite skips
// itself (rather than faking a pass) if python3 or forkpty is unavailable.
//
// `open`/`xdg-open` interception: the `open` npm package spawns `open` by
// bare name on darwin (PATH-resolved), so a fake `open` script placed first
// on PATH is invoked directly. On Linux it prefers its own bundled
// `xdg-open` script (an absolute path, NOT PATH-resolved) UNLESS that
// bundled copy is missing or non-executable. That bundled script only
// reads `$BROWSER` from its `open_generic()` branch, which `detectDE()`
// reaches ONLY when it fails to recognize a desktop environment — on a
// real desktop session (`XDG_CURRENT_DESKTOP` set, or a live `$DISPLAY`/
// `$WAYLAND_DISPLAY`) it instead dispatches to a real DE-specific opener
// (e.g. `kde-open5`), bypassing `$BROWSER` entirely and never touching the
// fake opener. `detectDE()`'s `X-Generic` case short-circuits straight to
// `open_generic`, so the child env below pins
// `XDG_CURRENT_DESKTOP=X-Generic` and drops `DISPLAY`/`WAYLAND_DISPLAY`
// (whose presence alone routes `open_generic` to a real browser launch
// ahead of `$BROWSER` — see `has_display()`), making `$BROWSER` reach the
// fake executable regardless of the host desktop session.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { findAvailablePort } from './daemon-run.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// tsx resolves as a devDependency of the mcp-server package, not the repo
// root workspace — the child's cwd must be the package dir for `tsx/esm`
// to resolve at all.
const MCP_SERVER_DIR = resolve(__dirname, '../..')
const CLI_SOURCE = resolve(__dirname, 'index.ts')
const PTY_BROKER = resolve(MCP_SERVER_DIR, 'scripts/dev/pty-broker.py')

const python3Check = spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore' })
const hasWorkingPty = python3Check.status === 0

const READINESS_TIMEOUT_MS = 15_000
const OPEN_SETTLE_MS = 1_000
const SHUTDOWN_TIMEOUT_MS = 5_000
const FAKE_BROWSER_COMMAND = 'whiteboard-fake-open'

const tempDirs: string[] = []
const liveChildren: Array<{ pid: number; closed: Promise<unknown> }> = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Overrides that stop the vendored `xdg-open`'s `detectDE()`/`has_display()`
 * from routing to a real desktop opener ahead of `$BROWSER` — see the file
 * header comment. Spread into every test's child env so the host desktop
 * session can't change the outcome of the guard under test. */
const NEUTRALIZED_DESKTOP_ENV = {
  XDG_CURRENT_DESKTOP: 'X-Generic',
  DISPLAY: undefined,
  WAYLAND_DISPLAY: undefined,
} as const

/** A fake `open`/`xdg-open`/$BROWSER opener that records its single argv URL. */
function makeFakeOpenBin(): { binDir: string; recordFile: string } {
  const binDir = makeTempDir('whiteboard-auto-open-launch-bin-')
  const recordFile = join(binDir, 'record.txt')
  const script = `#!/bin/sh\necho "$1" >> "${recordFile}"\nexit 0\n`
  for (const name of ['open', 'xdg-open', FAKE_BROWSER_COMMAND]) {
    const path = join(binDir, name)
    writeFileSync(path, script, { mode: 0o755 })
  }
  return { binDir, recordFile }
}

interface LaunchResult {
  readyLine: Record<string, unknown>
  pid: number
  closed: Promise<unknown>
}

/** Boots the real dispatcher CLI (via tsx) inside a real pty, and resolves
 * once the ready JSON line has been observed. */
async function launchDaemonInPty(args: {
  port: number
  dataDir: string
  extraArgs?: readonly string[]
  extraEnv?: Readonly<Record<string, string | undefined>>
}): Promise<LaunchResult> {
  const pidfile = join(makeTempDir('whiteboard-auto-open-launch-pid-'), 'pid')
  const cliArgs = [
    'node',
    '--import',
    'tsx/esm',
    CLI_SOURCE,
    'daemon',
    'run',
    '--json',
    '--host=127.0.0.1',
    `--port=${args.port}`,
    `--data-dir=${args.dataDir}`,
    ...(args.extraArgs ?? []),
  ]
  const child = spawn('python3', [PTY_BROKER, '--pidfile', pidfile, '--', ...cliArgs], {
    cwd: MCP_SERVER_DIR,
    env: { ...process.env, ...args.extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let buffer = ''
  let readyLine: Record<string, unknown> | null = null
  let readyResolve!: (value: Record<string, unknown>) => void
  const readyPromise = new Promise<Record<string, unknown>>((res) => {
    readyResolve = res
  })
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
      buffer = buffer.slice(newlineIndex + 1)
      if (readyLine === null && line.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>
          if (parsed.ok === true && typeof parsed.port === 'number') {
            readyLine = parsed
            readyResolve(parsed)
          }
        } catch {
          // Not the ready line (a log line, tsx diagnostic, …) — keep scanning.
        }
      }
      newlineIndex = buffer.indexOf('\n')
    }
  })

  const closed = new Promise((res) => child.once('close', res))

  const winner = await Promise.race([readyPromise, delay(READINESS_TIMEOUT_MS, 'timeout' as const)])
  if (winner === 'timeout') {
    throw new Error(`daemon did not emit ready JSON within ${READINESS_TIMEOUT_MS}ms`)
  }

  let pid: number
  try {
    pid = Number.parseInt(readFileSync(pidfile, 'utf8').trim(), 10)
  } catch (err) {
    throw new Error(`pidfile was not written by pty-broker: ${String(err)}`)
  }
  liveChildren.push({ pid, closed })

  return { readyLine: winner, pid, closed }
}

/** The opener's record file, or `''` while it has never been invoked. */
function readRecord(recordFile: string): string {
  try {
    return readFileSync(recordFile, 'utf8')
  } catch {
    return ''
  }
}

/** Polls `recordFile` until it has at least one line or `deadlineMs` elapses.
 * Deterministic stand-in for a fixed sleep: the positive assertion's outcome
 * must not depend on how long the harness happens to wait past the first
 * write. */
async function pollForRecordedLines(recordFile: string, deadlineMs: number): Promise<string[]> {
  const start = Date.now()
  for (;;) {
    const lines = readRecord(recordFile)
      .split('\n')
      .filter((l) => l.length > 0)
    if (lines.length > 0 || Date.now() - start >= deadlineMs) {
      return lines
    }
    await delay(50)
  }
}

async function killAndWait(pid: number, closed: Promise<unknown>): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
  const result = await Promise.race([closed, delay(SHUTDOWN_TIMEOUT_MS, 'timeout' as const)])
  if (result === 'timeout') {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
    await closed
  }
}

afterEach(async () => {
  while (liveChildren.length > 0) {
    const entry = liveChildren.pop()
    if (entry) await killAndWait(entry.pid, entry.closed)
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// A CI runner is expected to always have python3/forkpty (see the file
// header). Skipping there too would let the suite vanish silently instead
// of failing loudly if a runner image ever lost it; a dev machine without a
// working pty still skips.
describe.skipIf(!hasWorkingPty && !process.env.CI)(
  'daemon run auto-open: real process launch',
  () => {
    it(
      'invokes the fake opener with the hosted app URL exactly once when every guard passes',
      async () => {
        const port = await findAvailablePort(4310)
        const dataDir = makeTempDir('whiteboard-auto-open-launch-data-')
        const { binDir, recordFile } = makeFakeOpenBin()

        const { pid, closed } = await launchDaemonInPty({
          port,
          dataDir,
          extraEnv: {
            PATH: `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`,
            BROWSER: FAKE_BROWSER_COMMAND,
            CI: undefined,
            container: undefined,
            ...NEUTRALIZED_DESKTOP_ENV,
          },
        })

        // The open() call is awaited before the dispatcher's never-resolving
        // keep-alive promise, but the fake opener's own exit still round-trips
        // through a real subprocess spawn.
        const lines = await pollForRecordedLines(recordFile, OPEN_SETTLE_MS)

        await killAndWait(pid, closed)
        liveChildren.splice(0, liveChildren.length)

        expect(lines).toEqual(['https://kamiazya-whiteboard.pages.dev/'])
      },
      READINESS_TIMEOUT_MS + OPEN_SETTLE_MS + SHUTDOWN_TIMEOUT_MS + 5_000,
    )

    it(
      'never invokes the opener when CI=true, even with a real TTY',
      async () => {
        const port = await findAvailablePort(4311)
        const dataDir = makeTempDir('whiteboard-auto-open-launch-data-')
        const { binDir, recordFile } = makeFakeOpenBin()

        const { pid, closed } = await launchDaemonInPty({
          port,
          dataDir,
          extraEnv: {
            PATH: `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`,
            BROWSER: FAKE_BROWSER_COMMAND,
            CI: 'true',
            ...NEUTRALIZED_DESKTOP_ENV,
          },
        })

        await delay(OPEN_SETTLE_MS)
        const recorded = readRecord(recordFile)

        await killAndWait(pid, closed)
        liveChildren.splice(0, liveChildren.length)

        expect(recorded).toBe('')
      },
      READINESS_TIMEOUT_MS + OPEN_SETTLE_MS + SHUTDOWN_TIMEOUT_MS + 5_000,
    )

    it(
      'never invokes the opener when --no-open is passed, even with a real TTY',
      async () => {
        const port = await findAvailablePort(4312)
        const dataDir = makeTempDir('whiteboard-auto-open-launch-data-')
        const { binDir, recordFile } = makeFakeOpenBin()

        const { pid, closed } = await launchDaemonInPty({
          port,
          dataDir,
          extraArgs: ['--no-open'],
          extraEnv: {
            PATH: `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`,
            BROWSER: FAKE_BROWSER_COMMAND,
            CI: undefined,
            container: undefined,
            ...NEUTRALIZED_DESKTOP_ENV,
          },
        })

        await delay(OPEN_SETTLE_MS)
        const recorded = readRecord(recordFile)

        await killAndWait(pid, closed)
        liveChildren.splice(0, liveChildren.length)

        expect(recorded).toBe('')
      },
      READINESS_TIMEOUT_MS + OPEN_SETTLE_MS + SHUTDOWN_TIMEOUT_MS + 5_000,
    )
  },
)
