import { afterEach, describe, expect, it, vi } from 'vitest'
import { installUnloadShim } from './unload-shim.js'

describe('installUnloadShim', () => {
  let uninstall: (() => void) | null = null

  afterEach(() => {
    uninstall?.()
    uninstall = null
  })

  it('translates an "unload" listener into a "pagehide" listener', () => {
    uninstall = installUnloadShim()
    const handler = vi.fn()
    window.addEventListener('unload', handler)

    window.dispatchEvent(new Event('pagehide'))

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('never registers a native "unload" listener — Chrome logs a Permissions-Policy violation for it', () => {
    const nativeAdd = vi.fn(window.addEventListener.bind(window))
    window.addEventListener = nativeAdd as typeof window.addEventListener
    uninstall = installUnloadShim()

    const handler = vi.fn()
    window.addEventListener('unload', handler)

    const registeredTypes = nativeAdd.mock.calls.map((call) => call[0])
    expect(registeredTypes).not.toContain('unload')
    expect(registeredTypes).toContain('pagehide')
  })

  it('removeEventListener("unload", fn) detaches the mapped pagehide listener (add/remove symmetry)', () => {
    uninstall = installUnloadShim()
    const handler = vi.fn()
    window.addEventListener('unload', handler)
    window.removeEventListener('unload', handler)

    window.dispatchEvent(new Event('pagehide'))

    expect(handler).not.toHaveBeenCalled()
  })

  it('leaves listeners for other event types untouched (pass-through)', () => {
    uninstall = installUnloadShim()
    const handler = vi.fn()
    window.addEventListener('click', handler)

    window.dispatchEvent(new Event('click'))

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('uninstalling the shim stops translating "unload" registrations', () => {
    const nativeAdd = vi.fn(window.addEventListener.bind(window))
    window.addEventListener = nativeAdd as typeof window.addEventListener
    const teardown = installUnloadShim()
    teardown()

    const handler = vi.fn()
    window.addEventListener('unload', handler)
    window.removeEventListener('unload', handler)

    const registeredTypes = nativeAdd.mock.calls.map((call) => call[0])
    expect(registeredTypes).toContain('unload')
  })
})
