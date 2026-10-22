import { describe, expect, it } from 'vitest'
import type { BrowserPersistenceState } from './browser-persistence-state.js'
import type { ConnectionState } from './connection-state.js'
import { saveIndicatorOf } from './save-indicator.js'

const saved: BrowserPersistenceState = { kind: 'saved', lastSavedAt: null }
const pending: BrowserPersistenceState = { kind: 'pending', lastSavedAt: null }
const saving: BrowserPersistenceState = { kind: 'saving', lastSavedAt: null }

const browser = (storage: 'ok' | 'stuck' | 'failed'): ConnectionState => ({
  keeper: 'browser',
  storage,
})
const daemon = (
  session: 'synced' | 'reconnecting' | 'sync-off' | 'write-failed' | 'not-opened',
): ConnectionState => ({ keeper: 'daemon', session })

describe('saveIndicatorOf', () => {
  it('says Saved once nothing is waiting on a write', () => {
    expect(saveIndicatorOf(saved, browser('ok'))).toEqual({ tone: 'saved', label: 'Saved' })
    expect(saveIndicatorOf(saved, daemon('synced'))).toEqual({ tone: 'saved', label: 'Saved' })
  })

  it('says Saving while a write is pending or in flight', () => {
    for (const p of [pending, saving]) {
      expect(saveIndicatorOf(p, browser('ok'))).toEqual({ tone: 'saving', label: 'Saving…' })
      expect(saveIndicatorOf(p, daemon('synced'))).toEqual({ tone: 'saving', label: 'Saving…' })
    }
  })

  it('names a storage problem when the keeper is not keeping', () => {
    const problem = { tone: 'problem', label: 'Not saved — storage problem' }
    expect(saveIndicatorOf(pending, browser('stuck'))).toEqual(problem)
    expect(saveIndicatorOf(saved, browser('failed'))).toEqual(problem)
    expect(saveIndicatorOf(pending, daemon('write-failed'))).toEqual(problem)
    expect(saveIndicatorOf(saved, { keeper: 'replica', storage: 'failed' })).toEqual(problem)
  })

  it('says the changes are kept here when the daemon is out of reach', () => {
    const offline = { tone: 'problem', label: 'Offline — changes kept here' }
    expect(saveIndicatorOf(saved, daemon('sync-off'))).toEqual(offline)
    expect(saveIndicatorOf(pending, daemon('not-opened'))).toEqual(offline)
    expect(saveIndicatorOf(saved, { keeper: 'replica', storage: 'ok' })).toEqual(offline)
  })

  it('treats a transient reconnect as pending, not a problem', () => {
    expect(saveIndicatorOf(saved, daemon('reconnecting'))).toEqual({
      tone: 'saving',
      label: 'Reconnecting…',
    })
  })
})
