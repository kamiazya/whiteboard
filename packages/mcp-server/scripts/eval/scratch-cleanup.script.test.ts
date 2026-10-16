// The eval copies a full daemon data dir per trial into one scratch directory,
// so a run that stops early must still remove it — the interrupted run is the
// common one, since the lane takes minutes and its answer often prints before
// it ends. `--dry-run` reaches the same scratch directory without calling a
// model, so this spends no quota.
//
// The eval's own exit is NOT the moment to look: a server child it failed to
// close outlives it and writes the data dir back (identity file included)
// after the exit hook removed it. So the test records every process the eval
// spawned before signalling it, waits until each is gone, and only then
// inspects the directory.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const EVAL = resolve(import.meta.dirname, 'mcp-tool-surface-eval.mjs')

let privateTmp: string | undefined

afterEach(() => {
  if (privateTmp !== undefined) rmSync(privateTmp, { recursive: true, force: true })
  privateTmp = undefined
})

interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  readonly zombie: boolean
}

function processTable(): ProcessRow[] {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,stat='], { encoding: 'utf8' })
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 3)
    .map(([pid, ppid, stat]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      zombie: (stat ?? '').startsWith('Z'),
    }))
}

function descendantsOf(root: number): number[] {
  const rows = processTable()
  const found: number[] = []
  const frontier = [root]
  while (frontier.length > 0) {
    const parent = frontier.pop()
    for (const row of rows) {
      if (row.ppid !== parent || row.zombie) continue
      found.push(row.pid)
      frontier.push(row.pid)
    }
  }
  return found
}

// A zombie has stopped running, so it can write nothing; an init that never
// reaps would otherwise keep the wait below open forever.
const stillRunning = (pids: readonly number[]) => {
  const running = new Set(
    processTable()
      .filter((row) => !row.zombie)
      .map((row) => row.pid),
  )
  return pids.filter((pid) => running.has(pid))
}

function interruptAfterSeeding(signal: NodeJS.Signals, tmp: string) {
  return new Promise<{
    code: number | null
    output: string
    sawScratch: boolean
    spawned: number[]
  }>((done, fail) => {
    const child = spawn(process.execPath, [EVAL, '--dry-run'], {
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, PATH: '' },
    })
    let output = ''
    let seeding = false
    let sawScratch = false
    let spawned: number[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    const signalOnceServing = async () => {
      // The seeding server child must exist at the signal, or there is no
      // child for the handler to have failed to close.
      await vi.waitFor(
        () => {
          if (!output.includes('[eval] seeding')) throw new Error('not seeding yet')
          spawned = descendantsOf(child.pid ?? -1)
          if (spawned.length === 0) throw new Error('no server child yet')
        },
        { timeout: 60_000, interval: 20 },
      )
      seeding = true
      // Present at the moment of the signal, so an absence afterwards is the
      // handler's doing rather than a directory that was never made.
      sawScratch = scratchDirs(tmp).length > 0
      child.kill(signal)
    }
    child.on('exit', (code) => {
      if (!seeding) fail(new Error(`eval exited before seeding:\n${output}`))
      else done({ code, output, sawScratch, spawned })
    })
    signalOnceServing().catch(fail)
  })
}

const scratchDirs = (tmp: string) =>
  readdirSync(tmp).filter((name) => name.startsWith('whiteboard-tool-surface-eval-'))

// tsx's compile cache is the one thing the run may leave in TMPDIR: it holds
// transpiled source, nothing from the workspace.
const leftovers = (tmp: string) =>
  readdirSync(tmp, { recursive: true, encoding: 'utf8' }).filter(
    (entry) => !entry.startsWith('tsx-'),
  )

describe('the tool-surface eval removes its scratch workspace when interrupted', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`${signal} after seeding starts exits 130 and leaves no scratch directory`, async () => {
      privateTmp = mkdtempSync(join(tmpdir(), 'wb-eval-cleanup-'))
      const tmp = privateTmp
      const result = await interruptAfterSeeding(signal, tmp)

      expect(result.sawScratch, result.output).toBe(true)
      expect(result.code, result.output).toBe(130)
      await vi.waitFor(() => expect(stillRunning(result.spawned)).toEqual([]), {
        timeout: 20_000,
        interval: 100,
      })
      expect(leftovers(tmp), result.output).toEqual([])
    }, 120_000)
  }
})
