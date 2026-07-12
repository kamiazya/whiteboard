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
// bundled copy is missing or non-executable — but that bundled script
// itself honors the `$BROWSER` environment variable ahead of any
// desktop-specific detection, so setting `BROWSER=<fake command name>` (in
// addition to the PATH shim) reaches the same fake executable on both
// platforms without touching node_modules.
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

describe.skipIf(!hasWorkingPty)('daemon run auto-open: real process launch', () => {
  it(
    'invokes the fake opener with the daemon origin URL exactly once when every guard passes',
    async () => {
      const port = await findAvailablePort(4310)
      const dataDir = makeTempDir('whiteboard-auto-open-launch-data-')
      const { recordFile } = makeFakeOpenBin()
      const binDir = dirname(recordFile)

      const { pid, closed } = await launchDaemonInPty({
        port,
        dataDir,
        extraEnv: {
          PATH: `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`,
          BROWSER: FAKE_BROWSER_COMMAND,
          CI: undefined,
          container: undefined,
        },
      })

      // The open() call is awaited before the dispatcher's never-resolving
      // keep-alive promise, but the fake opener's own exit still round-trips
      // through a real subprocess spawn — give it a moment to land on disk.
      await delay(OPEN_SETTLE_MS)

      let recorded: string
      try {
        recorded = readFileSync(recordFile, 'utf8')
      } catch {
        recorded = ''
      }
      const lines = recorded.split('\n').filter((l) => l.length > 0)

      await killAndWait(pid, closed)
      liveChildren.splice(0, liveChildren.length)

      expect(lines).toEqual([`http://127.0.0.1:${port}`])
    },
    READINESS_TIMEOUT_MS + OPEN_SETTLE_MS + SHUTDOWN_TIMEOUT_MS + 5_000,
  )

  it(
    'never invokes the opener when CI=true, even with a real TTY',
    async () => {
      const port = await findAvailablePort(4311)
      const dataDir = makeTempDir('whiteboard-auto-open-launch-data-')
      const { recordFile } = makeFakeOpenBin()
      const binDir = dirname(recordFile)

      const { pid, closed } = await launchDaemonInPty({
        port,
        dataDir,
        extraEnv: {
          PATH: `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`,
          BROWSER: FAKE_BROWSER_COMMAND,
          CI: 'true',
        },
      })

      await delay(OPEN_SETTLE_MS)

      let recorded: string
      try {
        recorded = readFileSync(recordFile, 'utf8')
      } catch {
        recorded = ''
      }

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
      const { recordFile } = makeFakeOpenBin()
      const binDir = dirname(recordFile)

      const { pid, closed } = await launchDaemonInPty({
        port,
        dataDir,
        extraArgs: ['--no-open'],
        extraEnv: {
          PATH: `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`,
          BROWSER: FAKE_BROWSER_COMMAND,
          CI: undefined,
          container: undefined,
        },
      })

      await delay(OPEN_SETTLE_MS)

      let recorded: string
      try {
        recorded = readFileSync(recordFile, 'utf8')
      } catch {
        recorded = ''
      }

      await killAndWait(pid, closed)
      liveChildren.splice(0, liveChildren.length)

      expect(recorded).toBe('')
    },
    READINESS_TIMEOUT_MS + OPEN_SETTLE_MS + SHUTDOWN_TIMEOUT_MS + 5_000,
  )
})
