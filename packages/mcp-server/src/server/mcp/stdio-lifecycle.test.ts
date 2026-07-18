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

  it('exits with code 1 when stdin emits "error", distinguishing it from a clean disconnect', async () => {
    const { stdin, exit, closeServer } = makeDeps()
    stdin.emit('error', new Error('boom'))
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
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

  it('does not call exit twice when closeServer settles just after the hard-exit timer fires', async () => {
    vi.useFakeTimers()
    try {
      const stdin = new EventEmitter()
      const signals = new EventEmitter()
      const exit = vi.fn()
      let resolveClose: () => void = () => undefined
      const closeServer = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveClose = resolve
          }),
      )
      installStdioLifecycle({
        stdin,
        signals: { on: (event, listener) => signals.on(event, listener) },
        closeServer,
        exit,
      })

      stdin.emit('end')
      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_TIMEOUT_MS)
      expect(exit).toHaveBeenCalledTimes(1)

      // closeServer settles after the hard-exit timer already forced exit.
      resolveClose()
      await vi.runOnlyPendingTimersAsync()
      expect(exit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('awaits shutdownExtra alongside closeServer before exiting', async () => {
    const stdin = new EventEmitter()
    const signals = new EventEmitter()
    const exit = vi.fn()
    const closeServer = vi.fn(async () => undefined)
    let resolveExtra: () => void = () => undefined
    const shutdownExtra = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveExtra = resolve
        }),
    )
    installStdioLifecycle({
      stdin,
      signals: { on: (event, listener) => signals.on(event, listener) },
      closeServer,
      exit,
      shutdownExtra,
    })

    stdin.emit('end')
    await vi.waitFor(() => expect(closeServer).toHaveBeenCalledOnce())
    expect(exit).not.toHaveBeenCalled()

    resolveExtra()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
  })

  it('still exits when closeServer throws synchronously instead of returning a rejected promise', async () => {
    const stdin = new EventEmitter()
    const signals = new EventEmitter()
    const exit = vi.fn()
    const closeServer = vi.fn((): never => {
      throw new Error('boom: synchronous throw')
    })
    installStdioLifecycle({
      stdin,
      signals: { on: (event, listener) => signals.on(event, listener) },
      // @ts-expect-error -- deliberately violating the () => Promise<void> contract to
      // simulate a caller that throws before ever returning a promise.
      closeServer,
      exit,
    })

    stdin.emit('end')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
  })
})
