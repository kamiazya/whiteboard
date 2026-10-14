// The eval copies a full daemon data dir per trial into one scratch directory,
// so a run that stops early must still remove it — the interrupted run is the
// common one, since the lane takes minutes and its answer often prints before
// it ends. `--dry-run` reaches the same scratch directory without calling a
// model, so this spends no quota.
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const EVAL = resolve(import.meta.dirname, 'mcp-tool-surface-eval.mjs')

let privateTmp: string | undefined

afterEach(() => {
  if (privateTmp !== undefined) rmSync(privateTmp, { recursive: true, force: true })
  privateTmp = undefined
})

function interruptAfterSeeding(signal: NodeJS.Signals, tmp: string) {
  return new Promise<{ code: number | null; output: string; sawScratch: boolean }>((done) => {
    const child = spawn(process.execPath, [EVAL, '--dry-run'], {
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, PATH: '' },
    })
    let output = ''
    let sent = false
    let sawScratch = false
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      if (!sent && output.includes('[eval] seeding')) {
        sent = true
        // Present at the moment of the signal, so an absence afterwards is the
        // handler's doing rather than a directory that was never made.
        sawScratch = scratchDirs(tmp).length > 0
        child.kill(signal)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => done({ code, output, sawScratch }))
  })
}

const scratchDirs = (tmp: string) =>
  readdirSync(tmp).filter((name) => name.startsWith('whiteboard-tool-surface-eval-'))

describe('the tool-surface eval removes its scratch workspace when interrupted', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`${signal} after seeding starts exits 130 and leaves no scratch directory`, async () => {
      privateTmp = mkdtempSync(join(tmpdir(), 'wb-eval-cleanup-'))
      const result = await interruptAfterSeeding(signal, privateTmp)

      expect(result.sawScratch, result.output).toBe(true)
      expect(result.code, result.output).toBe(130)
      expect(scratchDirs(privateTmp), result.output).toEqual([])
    }, 90_000)
  }
})
