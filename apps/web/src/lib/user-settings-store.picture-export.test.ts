import { beforeEach, describe, expect, it } from 'vitest'
import { createUserSettingsStore, defaultUserSettings, STORAGE_KEY } from './user-settings-store.js'

beforeEach(() => {
  localStorage.clear()
})

describe('picture export settings', () => {
  it('round-trips both toggles', () => {
    const store = createUserSettingsStore()
    store.update((s) => ({ ...s, pictureExport: { doubleResolution: true, background: false } }))
    expect(store.load().pictureExport).toEqual({ doubleResolution: true, background: false })
  })

  it('parses a stored payload from before the section existed', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 5, storage: {}, migration: {}, capabilities: {} }),
    )
    expect(createUserSettingsStore().load().pictureExport).toBeUndefined()
  })

  it('refuses to write a key the section does not name', () => {
    const store = createUserSettingsStore()
    store.save({ ...defaultUserSettings(), pictureExport: { token: 'x' } as never })
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })
})
