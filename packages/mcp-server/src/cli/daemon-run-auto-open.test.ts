import { describe, expect, it, vi } from 'vitest'
import { maybeOpenDaemonBrowser } from './daemon-run-auto-open.js'

function baseInput(overrides: Partial<Parameters<typeof maybeOpenDaemonBrowser>[0]> = {}) {
  return {
    host: '127.0.0.1',
    port: 3099,
    noOpenFlag: false,
    configOpenBrowser: undefined,
    isTTY: true,
    env: {},
    isContainerFn: () => false,
    openFn: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('maybeOpenDaemonBrowser', () => {
  it('opens the official hosted app URL when every guard passes', async () => {
    const input = baseInput()
    await maybeOpenDaemonBrowser(input)
    expect(input.openFn).toHaveBeenCalledWith('https://kamiazya-whiteboard.pages.dev/')
  })

  it('does not open when --no-open was passed', async () => {
    const input = baseInput({ noOpenFlag: true })
    await maybeOpenDaemonBrowser(input)
    expect(input.openFn).not.toHaveBeenCalled()
  })

  it('does not open when the config file sets openBrowser: false', async () => {
    const input = baseInput({ configOpenBrowser: false })
    await maybeOpenDaemonBrowser(input)
    expect(input.openFn).not.toHaveBeenCalled()
  })

  it('--no-open overrides a config file openBrowser: true', async () => {
    const input = baseInput({ noOpenFlag: true, configOpenBrowser: true })
    await maybeOpenDaemonBrowser(input)
    expect(input.openFn).not.toHaveBeenCalled()
  })

  it('does not open when stdout is not a TTY', async () => {
    const input = baseInput({ isTTY: false })
    await maybeOpenDaemonBrowser(input)
    expect(input.openFn).not.toHaveBeenCalled()
  })

  it('does not open when CI is set', async () => {
    const input = baseInput({ env: { CI: 'true' } })
    await maybeOpenDaemonBrowser(input)
    expect(input.openFn).not.toHaveBeenCalled()
  })

  it('does not open inside a container', async () => {
    const input = baseInput({ isContainerFn: () => true })
    await maybeOpenDaemonBrowser(input)
    expect(input.openFn).not.toHaveBeenCalled()
  })

  it('does not open on a non-loopback host', async () => {
    const input = baseInput({ host: '0.0.0.0' })
    await maybeOpenDaemonBrowser(input)
    expect(input.openFn).not.toHaveBeenCalled()
  })

  it('swallows an open() rejection instead of throwing', async () => {
    const input = baseInput({ openFn: vi.fn(async () => Promise.reject(new Error('no display'))) })
    await expect(maybeOpenDaemonBrowser(input)).resolves.toBeUndefined()
  })

  // A best-effort UX nicety must never be able to take the daemon down.
  // decideAutoOpenBrowser and the container probe are both synchronous
  // calls inside maybeOpenDaemonBrowser's own body (not just openFn), so a
  // throw from either of them has to be caught at the same boundary as an
  // openFn rejection — otherwise a bug in the policy/detection code crashes
  // an otherwise fully-started daemon.
  it('swallows a throw from the container-detection probe instead of crashing the daemon', async () => {
    const input = baseInput({
      isContainerFn: () => {
        throw new Error('cgroup read exploded')
      },
    })
    await expect(maybeOpenDaemonBrowser(input)).resolves.toBeUndefined()
    expect(input.openFn).not.toHaveBeenCalled()
  })
})
