import type { ChildProcess } from 'node:child_process'
import EventEmitter from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { monitorChildAfterReady } from './hono-lifecycle.js'

// Minimal ChildProcess mock backed by EventEmitter.
function makeChildProcess(): ChildProcess {
  return new EventEmitter() as unknown as ChildProcess
}

describe('monitorChildAfterReady', () => {
  it('calls cleanup when the child exits with code 1 after READY', () => {
    const child = makeChildProcess()
    const cleanup = vi.fn()
    const exit = vi.fn()

    monitorChildAfterReady(child, cleanup, exit)
    child.emit('exit', 1, null)

    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('calls exit(1) when the child exits with code 1 after READY', () => {
    const child = makeChildProcess()
    const cleanup = vi.fn()
    const exit = vi.fn()

    monitorChildAfterReady(child, cleanup, exit)
    child.emit('exit', 1, null)

    expect(exit).toHaveBeenCalledWith(1)
  })

  it('calls cleanup even on a normal exit code 0 so .port is always removed', () => {
    const child = makeChildProcess()
    const cleanup = vi.fn()
    const exit = vi.fn()

    monitorChildAfterReady(child, cleanup, exit)
    child.emit('exit', 0, null)

    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('calls cleanup when the child exits due to SIGTERM', () => {
    const child = makeChildProcess()
    const cleanup = vi.fn()
    const exit = vi.fn()

    monitorChildAfterReady(child, cleanup, exit)
    child.emit('exit', null, 'SIGTERM')

    expect(cleanup).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('does not call cleanup before exit fires', () => {
    const child = makeChildProcess()
    const cleanup = vi.fn()
    const exit = vi.fn()

    monitorChildAfterReady(child, cleanup, exit)
    // exit has not been emitted yet.

    expect(cleanup).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })
})
