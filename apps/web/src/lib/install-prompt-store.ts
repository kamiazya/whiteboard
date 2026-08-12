import { getAppLogger } from './app-logger.js'

const log = getAppLogger('install-prompt')

export interface InstallState {
  /**
   * installed — running standalone or `appinstalled` fired this session;
   * installable — a `beforeinstallprompt` event is captured and can be
   * replayed; not-captured — the browser offered nothing (unsupported, or
   * install criteria not met), so only its own menu can install.
   */
  status: 'installed' | 'installable' | 'not-captured'
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
}

// Module-level store: `beforeinstallprompt` fires once, early, before any
// settings UI mounts — the capture must be armed from the boot path and the
// stashed event kept outside React.
let state: InstallState = { status: 'not-captured' }
let deferredPrompt: BeforeInstallPromptEvent | null = null
let initialized = false
const listeners = new Set<() => void>()

const onBeforeInstallPrompt = (event: Event): void => {
  // preventDefault suppresses Chrome's own mini-infobar so the install
  // entry point lives in the settings journey instead.
  event.preventDefault()
  deferredPrompt = event as BeforeInstallPromptEvent
  set({ status: 'installable' })
}

const onAppInstalled = (): void => {
  deferredPrompt = null
  set({ status: 'installed' })
}

function set(next: InstallState): void {
  state = next
  for (const listener of listeners) listener()
}

export function subscribeInstallState(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getInstallState(): InstallState {
  return state
}

export function initInstallPromptCapture(): void {
  if (initialized) return
  initialized = true
  if (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) {
    set({ status: 'installed' })
  }
  window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  window.addEventListener('appinstalled', onAppInstalled)
}

export async function promptInstall(): Promise<void> {
  if (deferredPrompt === null) return
  try {
    await deferredPrompt.prompt()
  } catch (err) {
    log.warn('install prompt failed', err)
  }
}

export function resetInstallPromptForTests(): void {
  window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
  window.removeEventListener('appinstalled', onAppInstalled)
  state = { status: 'not-captured' }
  deferredPrompt = null
  initialized = false
  listeners.clear()
}
