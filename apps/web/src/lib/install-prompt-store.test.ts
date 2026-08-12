import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getInstallState,
  initInstallPromptCapture,
  promptInstall,
  resetInstallPromptForTests,
  subscribeInstallState,
} from './install-prompt-store.js'

function fireBeforeInstallPrompt(prompt = vi.fn().mockResolvedValue(undefined)) {
  const event = new Event('beforeinstallprompt') as Event & { prompt: () => Promise<void> }
  event.prompt = prompt
  window.dispatchEvent(event)
  return prompt
}

beforeEach(() => {
  resetInstallPromptForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('install-prompt-store', () => {
  it('starts not-captured when the app is not standalone', () => {
    initInstallPromptCapture()
    expect(getInstallState().status).toBe('not-captured')
  })

  it('starts installed when running in standalone display mode', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn() }),
    )
    initInstallPromptCapture()
    expect(getInstallState().status).toBe('installed')
  })

  it('captures beforeinstallprompt, prevents its default, and becomes installable', () => {
    initInstallPromptCapture()
    const listener = vi.fn()
    subscribeInstallState(listener)
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
      prompt: () => Promise<void>
    }
    event.prompt = vi.fn()
    window.dispatchEvent(event)
    expect(getInstallState().status).toBe('installable')
    expect(event.defaultPrevented).toBe(true)
    expect(listener).toHaveBeenCalled()
  })

  it('promptInstall calls the captured event prompt', async () => {
    initInstallPromptCapture()
    const prompt = fireBeforeInstallPrompt()
    await promptInstall()
    expect(prompt).toHaveBeenCalledTimes(1)
  })

  it('promptInstall is a safe no-op before capture', async () => {
    initInstallPromptCapture()
    await expect(promptInstall()).resolves.toBeUndefined()
  })

  it('appinstalled moves the state to installed', () => {
    initInstallPromptCapture()
    fireBeforeInstallPrompt()
    window.dispatchEvent(new Event('appinstalled'))
    expect(getInstallState().status).toBe('installed')
  })

  it('init is idempotent — a second call does not double-register listeners', () => {
    initInstallPromptCapture()
    initInstallPromptCapture()
    const listener = vi.fn()
    subscribeInstallState(listener)
    fireBeforeInstallPrompt()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
