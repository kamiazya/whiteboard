export interface UserSettings {
  defaultStorageProvider: 'browser-local' | 'local-daemon' | null
}

export function defaultUserSettings(): UserSettings {
  return { defaultStorageProvider: null }
}
