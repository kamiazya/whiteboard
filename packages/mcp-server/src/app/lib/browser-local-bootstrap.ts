import type { DaemonRuntimeConfig } from './storage-provider.js'
import type { UserSettings } from './user-settings-store.js'

function getModeFromUrl(hash: string, search: string): string | null {
  if (hash.startsWith('#')) {
    const mode = new URLSearchParams(hash.slice(1)).get('mode')
    if (mode) return mode
  }
  if (search.startsWith('?')) {
    const mode = new URLSearchParams(search.slice(1)).get('mode')
    if (mode) return mode
  }
  return null
}

export function resolveBrowserLocalRedirect(args: {
  locationHash: string
  locationSearch: string
  currentPathname: string
  daemonRuntimeConfig: DaemonRuntimeConfig | null
  settings: UserSettings
}): { replacePathname: string | null } {
  // Daemon config present (any token) means the page is already served
  // by the daemon; no redirect to the standalone browser-local path.
  if (args.daemonRuntimeConfig !== null) {
    return { replacePathname: null }
  }

  const urlMode = getModeFromUrl(args.locationHash, args.locationSearch)
  if (urlMode === 'browser-local' && args.currentPathname !== '/browser-local') {
    return { replacePathname: '/browser-local' }
  }

  return { replacePathname: null }
}
