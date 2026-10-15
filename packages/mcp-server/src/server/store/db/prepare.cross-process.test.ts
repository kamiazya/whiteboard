import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DB_FILENAME } from './index.js'
import { withMigrationLock } from './migration-lock.js'
import { migrations } from './migrations/index.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const prepareModule = fileURLToPath(new URL('./prepare.ts', import.meta.url))

// A second server on the same data dir: an `npx … mcp` beside a running daemon,
// or `pnpm mcp` twice. It runs the real startup path and reports how it ended.
const OPENER = `
const { prepareDataDir } = await import(process.argv[1])
try {
  await prepareDataDir(process.argv[2])
  console.log('prepared')
} catch (err) {
  console.log('failed: ' + (err instanceof Error ? err.message : String(err)))
  process.exitCode = 1
}
`

interface Opener {
  readonly child: ChildProcess
  /** Resolves once the opener has logged that it is waiting for the lock. */
  readonly waiting: Promise<void>
  readonly result: Promise<{ code: number | null; stdout: string }>
}

function startOpener(dataDir: string): Opener {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx/esm', '--input-type=module', '-e', OPENER, prepareModule, dataDir],
    {
      cwd: packageRoot,
      env: { ...process.env, WHITEBOARD_LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  const waiting = (async () => {
    const lines = createInterface({ input: child.stderr as NodeJS.ReadableStream })
    for await (const line of lines) {
      if (line.includes('waiting for another process to finish migrating')) return
    }
    throw new Error('the opener never waited for the migration lock')
  })()
  waiting.catch(() => {})
  const result = exited.then((code) => ({ code, stdout }))
  return { child, waiting, result }
}

let dataDir: string
const started: ChildProcess[] = []

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'wb-prepare-cross-process-'))
})
afterEach(async () => {
  for (const child of started.splice(0)) child.kill('SIGKILL')
  await rm(dataDir, { recursive: true, force: true })
})

describe('two processes opening one fresh data dir', () => {
  it('migrate it one at a time, and both start', { timeout: 120_000 }, async () => {
    let both: Opener[] = []
    // Held here until both openers are queued on it, so their race starts at
    // one release rather than at whenever each spawn happened to get going.
    await withMigrationLock(dataDir, async () => {
      both = [startOpener(dataDir), startOpener(dataDir)]
      started.push(...both.map((o) => o.child))
      await Promise.all(both.map((o) => o.waiting))
    })

    const results = await Promise.all(both.map((o) => o.result))
    expect(results).toEqual([
      { code: 0, stdout: 'prepared\n' },
      { code: 0, stdout: 'prepared\n' },
    ])

    const client = createClient({ url: `file:${join(dataDir, DB_FILENAME)}` })
    try {
      const { rows } = await client.execute('select name from kysely_migration order by name')
      expect(rows.map((r) => r.name)).toEqual(Object.keys(migrations).sort())
    } finally {
      client.close()
    }
  })
})
