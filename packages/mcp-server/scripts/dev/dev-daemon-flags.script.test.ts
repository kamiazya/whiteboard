// An unrecognised flag on a script that starts or stops a daemon must read as a refusal, never as
// consent: `--help` is a question and a typo such as `--quite` is not "start it anyway".
//
// Everything runs against a scratch WHITEBOARD_DATA_DIR. The stop script is aimed at a sacrificial
// process the test owns (named by a daemon record it wrote), and the ensure script at a PATH-shimmed
// `pnpm`, so neither case can touch a real daemon.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveRepoRootFromGit } from './with-dev-data-dir-lib.mjs'

const REPO_ROOT = resolveRepoRootFromGit(resolve(import.meta.dirname))
const STOP_SCRIPT = resolve(import.meta.dirname, 'stop-http-dev-daemon.mjs')
const ENSURE_SCRIPT = resolve(import.meta.dirname, 'ensure-http-dev-daemon.mjs')
const SHIM_ENTRY_PATH = resolve(import.meta.dirname, 'test-utils/fake-pnpm-shim.mjs')
const itPosix = it.skipIf(process.platform === 'win32')

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('dev daemon scripts refuse what they do not recognise', () => {
  const dirs: string[] = []
  const sacrifices: ChildProcess[] = []

  afterEach(() => {
    for (const child of sacrifices.splice(0)) child.kill('SIGKILL')
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function scratchDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }

  async function sacrificialDaemon(dataDir: string): Promise<number> {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    sacrifices.push(child)
    const pid = child.pid as number
    writeFileSync(
      join(dataDir, 'daemon.json'),
      JSON.stringify({ pid, socketPath: join(dataDir, 'none.sock'), token: 't' }),
    )
    return pid
  }

  describe('stop-http-dev-daemon.mjs', () => {
    for (const [flag, expectedStatus] of [
      ['--help', 0],
      ['--bogus', 2],
      ['--force', 2],
    ] as const) {
      itPosix(`${flag} exits ${expectedStatus} and signals nothing`, async () => {
        const dataDir = scratchDir('stop-flags-data-')
        const pid = await sacrificialDaemon(dataDir)

        const result = spawnSync(process.execPath, [STOP_SCRIPT, flag], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { ...process.env, WHITEBOARD_DATA_DIR: dataDir },
        })

        expect(result.status, `${result.stdout}${result.stderr}`).toBe(expectedStatus)
        expect(`${result.stdout}${result.stderr}`).toMatch(/usage: stop-http-dev-daemon/)
        expect(isAlive(pid), `${flag} signalled the daemon`).toBe(true)
      })
    }
  })

  describe('ensure-http-dev-daemon.mjs', () => {
    for (const [flag, expectedStatus] of [
      ['--help', 0],
      ['--quite', 2],
    ] as const) {
      itPosix(`${flag} exits ${expectedStatus} and spawns nothing`, () => {
        const dataDir = scratchDir('ensure-flags-data-')
        const shimDir = scratchDir('ensure-flags-shim-')
        const shimPath = join(shimDir, 'pnpm')
        writeFileSync(shimPath, `#!/bin/sh\nexec node "${SHIM_ENTRY_PATH}" "$@"\n`, { mode: 0o755 })
        const spawnedDir = join(dataDir, 'spawned')

        const result = spawnSync(process.execPath, [ENSURE_SCRIPT, flag], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          timeout: 20_000,
          env: {
            ...process.env,
            PATH: `${shimDir}:${process.env.PATH ?? ''}`,
            WHITEBOARD_DATA_DIR: dataDir,
            WHITEBOARD_DEV_READY_TIMEOUT_MS: '3000',
            FAKE_PNPM_INVOKED_SENTINEL_DIR: spawnedDir,
          },
        })
        // A shim the script wrongly started stays alive until killed.
        if (existsSync(spawnedDir)) {
          for (const file of readdirSync(spawnedDir)) {
            const pid = Number(file.split('-')[0])
            if (Number.isInteger(pid)) {
              try {
                process.kill(pid, 'SIGKILL')
              } catch {
                /* already gone */
              }
            }
          }
        }

        expect(result.status, `${result.stdout}${result.stderr}`).toBe(expectedStatus)
        expect(`${result.stdout}${result.stderr}`).toMatch(/usage: ensure-http-dev-daemon/)
        expect(existsSync(spawnedDir), `${flag} spawned the dev daemon`).toBe(false)
        expect(existsSync(join(dataDir, 'dev-daemon-spawn.lock'))).toBe(false)
      })
    }
  })
})
