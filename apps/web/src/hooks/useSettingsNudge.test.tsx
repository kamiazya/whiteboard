import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  initInstallPromptCapture,
  resetInstallPromptForTests,
} from '../lib/install-prompt-store.js'
import { bindApplyUpdate, resetSwStatusForTests } from '../pwa/sw-status-store.js'
import { useSettingsNudge } from './useSettingsNudge.js'

function stubPersisted(value: boolean | undefined) {
  Object.defineProperty(navigator, 'storage', {
    value: value === undefined ? undefined : { persisted: () => Promise.resolve(value) },
    configurable: true,
  })
}

beforeEach(() => {
  resetSwStatusForTests()
  resetInstallPromptForTests()
})

afterEach(() => {
  Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true })
})

describe('useSettingsNudge', () => {
  it('stays off when every reachable step is complete and no update waits', async () => {
    stubPersisted(true)
    const { result } = renderHook(() => useSettingsNudge(true))
    // let the persistence query settle
    await waitFor(() => expect(result.current).toBe(false))
  })

  it('lights for an ungranted persistence todo', async () => {
    stubPersisted(false)
    const { result } = renderHook(() => useSettingsNudge(true))
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('does not light where the browser manages persistence itself', async () => {
    stubPersisted(undefined)
    const { result } = renderHook(() => useSettingsNudge(true))
    await waitFor(() => expect(result.current).toBe(false))
  })

  it('lights when an install prompt is captured, but not for a blocked install', async () => {
    stubPersisted(true)
    initInstallPromptCapture()
    const { result } = renderHook(() => useSettingsNudge(true))
    await waitFor(() => expect(result.current).toBe(false))

    act(() => {
      const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
        prompt: () => Promise<void>
      }
      event.prompt = () => Promise.resolve()
      window.dispatchEvent(event)
    })
    expect(result.current).toBe(true)
  })

  it('lights while a daemon is not connected', async () => {
    stubPersisted(true)
    const { result } = renderHook(() => useSettingsNudge(false))
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('lights when a service worker update is waiting to apply', async () => {
    stubPersisted(true)
    const { result } = renderHook(() => useSettingsNudge(true))
    await waitFor(() => expect(result.current).toBe(false))

    act(() => {
      bindApplyUpdate(() => Promise.resolve())
    })
    expect(result.current).toBe(true)
  })
})
