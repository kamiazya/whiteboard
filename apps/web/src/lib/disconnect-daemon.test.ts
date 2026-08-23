// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { disconnectFromDaemon } from './disconnect-daemon.js'
import { createUserSettingsStore } from './user-settings-store.js'

const A = 'http://127.0.0.1:3099'
const B = 'http://127.0.0.1:4000'

beforeEach(() => localStorage.clear())

describe('disconnectFromDaemon', () => {
  it('clears the stored target so the next load is not daemon-backed', () => {
    const store = createUserSettingsStore()
    store.update((c) => ({ ...c, storage: { ...c.storage, localDaemonBaseUrl: A } }))
    disconnectFromDaemon(store, A)
    expect(createUserSettingsStore().load().storage.localDaemonBaseUrl).toBeUndefined()
  })

  // Forgetting alone is not enough: the default port range is rescanned on
  // every visit, so the same daemon would come straight back.
  it('records the dismissal and drops it from the known list', () => {
    const store = createUserSettingsStore()
    store.update((c) => ({ ...c, storage: { ...c.storage, knownDaemonBaseUrls: [A, B] } }))
    disconnectFromDaemon(store, A)
    const storage = createUserSettingsStore().load().storage
    expect(storage.dismissedDaemonBaseUrls).toContain(A)
    expect(storage.knownDaemonBaseUrls).toEqual([B])
  })

  // Another daemon's stored target is none of this call's business.
  it('leaves a different daemon connected', () => {
    const store = createUserSettingsStore()
    store.update((c) => ({ ...c, storage: { ...c.storage, localDaemonBaseUrl: B } }))
    disconnectFromDaemon(store, A)
    expect(createUserSettingsStore().load().storage.localDaemonBaseUrl).toBe(B)
  })

  it('is a skip-list, not an archive — bounded at five', () => {
    const store = createUserSettingsStore()
    for (const port of [3000, 3001, 3002, 3003, 3004, 3005]) {
      disconnectFromDaemon(store, `http://127.0.0.1:${port}`)
    }
    expect(createUserSettingsStore().load().storage.dismissedDaemonBaseUrls).toHaveLength(5)
  })
})
