import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { GRACEFUL_SHUTDOWN_TIMEOUT_MS, installStdioLifecycle } from './stdio-lifecycle.js'

function makeDeps() {
  const stdin = new EventEmitter()
  const signals = new EventEmitter()
  const exit = vi.fn()
  const closeServer = vi.fn(async () => undefined)
  installStdioLifecycle({
    stdin,
    signals: { on: (event, listener) => signals.on(event, listener) },
    closeServer,
    exit,
  })
  return { stdin, signals, exit, closeServer }
}

describe('installStdioLifecycle', () => {
  it('exits once stdin emits "end"', async () => {
    const { stdin, exit, closeServer } = makeDeps()
    stdin.emit('end')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(closeServer).toHaveBeenCalledOnce()
  })

  it('exits once stdin emits "close"', async () => {
    const { stdin, exit, closeServer } = makeDeps()
    stdin.emit('close')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(closeServer).toHaveBeenCalledOnce()
  })

  it('exits once stdin emits "error"', async () => {
    const { stdin, exit, closeServer } = makeDeps()
    stdin.emit('error', new Error('boom'))
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(closeServer).toHaveBeenCalledOnce()
  })

  it('exits once SIGTERM is delivered', async () => {
    const { signals, exit, closeServer } = makeDeps()
    signals.emit('SIGTERM')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(closeServer).toHaveBeenCalledOnce()
  })

  it('exits once SIGINT is delivered', async () => {
    const { signals, exit, closeServer } = makeDeps()
    signals.emit('SIGINT')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(closeServer).toHaveBeenCalledOnce()
  })

  it('only shuts down once when multiple triggers fire', async () => {
    const { stdin, signals, exit, closeServer } = makeDeps()
    stdin.emit('end')
    stdin.emit('close')
    signals.emit('SIGTERM')
    signals.emit('SIGINT')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1))
    expect(closeServer).toHaveBeenCalledOnce()
  })

  it('forces exit via an unref-ed timer when closeServer never resolves', async () => {
    vi.useFakeTimers()
    try {
      const stdin = new EventEmitter()
      const signals = new EventEmitter()
      const exit = vi.fn()
      const closeServer = vi.fn(() => new Promise<void>(() => undefined))
      installStdioLifecycle({
        stdin,
        signals: { on: (event, listener) => signals.on(event, listener) },
        closeServer,
        exit,
      })

      stdin.emit('end')
      expect(exit).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_TIMEOUT_MS)
      expect(exit).toHaveBeenCalledWith(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
