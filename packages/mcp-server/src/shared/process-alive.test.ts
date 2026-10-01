import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPidAlive } from './process-alive.js'

function killFailing(code: string) {
  return vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error(code), { code })
  })
}

describe('isPidAlive', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads the running test process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true)
  })

  it('reads a process that has exited and been reaped as dead', () => {
    const { pid } = spawnSync(process.execPath, ['-e', ''])
    expect(pid).toBeGreaterThan(0)
    expect(isPidAlive(pid)).toBe(false)
  })

  it('reads ESRCH (no such process) as dead', () => {
    killFailing('ESRCH')
    expect(isPidAlive(4242)).toBe(false)
  })

  // EPERM means the process EXISTS and this user may not signal it. Reading
  // that as dead lets a destructive restore run into a live server's data dir.
  it('reads EPERM (exists, not signalable) as alive', () => {
    killFailing('EPERM')
    expect(isPidAlive(4242)).toBe(true)
  })

  it('reads any other failure as dead', () => {
    killFailing('EINVAL')
    expect(isPidAlive(4242)).toBe(false)
  })

  // kill(0, 0) and kill(-n, 0) address a process GROUP, which exists whatever
  // the pid in a corrupt record said.
  it.each([
    0,
    -1,
    -4242,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('never asks the OS about %s', (pid) => {
    const kill = vi.spyOn(process, 'kill')
    expect(isPidAlive(pid)).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })
})
