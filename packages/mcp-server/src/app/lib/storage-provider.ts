import type { UserSettings } from './user-settings-store.js'

export interface DaemonRuntimeConfig {
  baseUrl: string
  token: string | null
}

export type StorageProviderResult =
  | { kind: 'local-daemon'; token: string | null; baseUrl: string; source: 'runtime-config' | 'url' }
  | { kind: 'browser-local'; source: 'url' | 'settings' }

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

export function resolveStorageProvider(args: {
  locationHash: string
  locationSearch: string
  daemonRuntimeConfig: DaemonRuntimeConfig | null
  settings: UserSettings
}): StorageProviderResult {
  const urlMode = getModeFromUrl(args.locationHash, args.locationSearch)

  if (urlMode === 'browser-local') {
    return { kind: 'browser-local', source: 'url' }
  }

  if (urlMode === 'local-daemon' && args.daemonRuntimeConfig !== null) {
    return {
      kind: 'local-daemon',
      token: args.daemonRuntimeConfig.token,
      baseUrl: args.daemonRuntimeConfig.baseUrl,
      source: 'url',
    }
  }

  if (args.daemonRuntimeConfig !== null) {
    return {
      kind: 'local-daemon',
      token: args.daemonRuntimeConfig.token,
      baseUrl: args.daemonRuntimeConfig.baseUrl,
      source: 'runtime-config',
    }
  }

  return { kind: 'browser-local', source: 'settings' }
}
