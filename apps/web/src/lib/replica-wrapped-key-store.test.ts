/**
 * Where a wrapped workspace key sits between tabs.
 *
 * The record is CIPHERTEXT (`daemon-client`'s `replica-key-wrap.ts`), so the
 * thing this store must never do is lose its shape silently: a record it
 * cannot parse has to read as absent, the way `loadOfflinePasskey` treats a
 * corrupt pin, rather than throwing into a cold start.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { dropWrappedKey, loadWrappedKey, saveWrappedKey } from './replica-wrapped-key-store.js'

const DAEMON = 'http://127.0.0.1:3099'
const OTHER = 'http://127.0.0.1:4000'
const BLOB = { v: 1 as const, iv: 'AAECAwQFBgcICQoL', ct: 'DA0ODxAREhMUFRYX' }

beforeEach(() => {
  localStorage.removeItem('whiteboard:replica-sealed-keys')
})

describe('saveWrappedKey / loadWrappedKey', () => {
  it('answers null before anything is stored', () => {
    expect(loadWrappedKey(DAEMON, 'ws-1')).toBeNull()
  })

  it('round-trips a blob for one (daemon, workspace) pair', () => {
    saveWrappedKey(DAEMON, 'ws-1', BLOB)

    expect(loadWrappedKey(DAEMON, 'ws-1')).toEqual(BLOB)
    // Scoped: neither the other workspace on this daemon nor the same
    // workspace id on another daemon reads it.
    expect(loadWrappedKey(DAEMON, 'ws-2')).toBeNull()
    expect(loadWrappedKey(OTHER, 'ws-1')).toBeNull()
  })

  it('normalises a trailing slash, so one daemon is one daemon', () => {
    saveWrappedKey(`${DAEMON}/`, 'ws-1', BLOB)

    // The pairing store already keys this way; two spellings of one daemon
    // would leave a blob nobody looks for.
    expect(loadWrappedKey(DAEMON, 'ws-1')).toEqual(BLOB)
  })

  it('replaces the blob for a pair rather than accumulating', () => {
    saveWrappedKey(DAEMON, 'ws-1', BLOB)
    const next = { ...BLOB, ct: 'GBkaGxwdHh8gISIj' }

    saveWrappedKey(DAEMON, 'ws-1', next)

    expect(loadWrappedKey(DAEMON, 'ws-1')).toEqual(next)
  })

  it('keeps pairs whose spellings would run together apart', () => {
    // Without a separator these two pairs concatenate to the same string.
    saveWrappedKey('http://127.0.0.1:1', '23', BLOB)
    const other = { ...BLOB, ct: 'GBkaGxwdHh8gISIj' }
    saveWrappedKey('http://127.0.0.1:12', '3', other)

    expect(loadWrappedKey('http://127.0.0.1:1', '23')).toEqual(BLOB)
    expect(loadWrappedKey('http://127.0.0.1:12', '3')).toEqual(other)
  })

  it('files a record under the daemon, a NUL and the workspace id', () => {
    saveWrappedKey(`${DAEMON}/`, 'ws-1', BLOB)

    // A record written by an earlier tab or build is found by this exact key,
    // so the on-disk spelling is part of the contract, not an implementation detail.
    const raw = JSON.parse(localStorage.getItem('whiteboard:replica-sealed-keys') ?? '{}')
    expect(Object.keys(raw)).toEqual([`${DAEMON}\u0000ws-1`])
  })

  it('reads a record it cannot parse as absent rather than throwing', () => {
    localStorage.setItem(
      'whiteboard:replica-sealed-keys',
      JSON.stringify({ [`${DAEMON}\u0000ws-1`]: { v: 2, iv: '!!', ct: 3 } }),
    )

    // A cold start must degrade to "ask the daemon", never to an exception
    // from a store. Same posture as a corrupt passkey pin.
    expect(loadWrappedKey(DAEMON, 'ws-1')).toBeNull()
  })

  it('reads a payload that is not JSON at all as absent', () => {
    localStorage.setItem('whiteboard:replica-sealed-keys', 'not json')

    expect(loadWrappedKey(DAEMON, 'ws-1')).toBeNull()
  })
})

describe('dropWrappedKey', () => {
  it('removes one pair and leaves the rest', () => {
    saveWrappedKey(DAEMON, 'ws-1', BLOB)
    saveWrappedKey(DAEMON, 'ws-2', BLOB)

    dropWrappedKey(DAEMON, 'ws-1')

    expect(loadWrappedKey(DAEMON, 'ws-1')).toBeNull()
    expect(loadWrappedKey(DAEMON, 'ws-2')).toEqual(BLOB)
  })
})

describe('a store holding an entry this build cannot read', () => {
  // The same newer-build case as the pin store: one unreadable entry must
  // cost that entry, and saving another must not write every other away.
  const seedWithUnreadable = () => {
    saveWrappedKey(DAEMON, 'ws-1', BLOB)
    const raw = JSON.parse(localStorage.getItem('whiteboard:replica-sealed-keys') ?? '{}')
    raw['from-a-newer-build'] = { ...BLOB, addedByANewerBuild: true }
    localStorage.setItem('whiteboard:replica-sealed-keys', JSON.stringify(raw))
  }

  it('still answers the entries it can read', () => {
    seedWithUnreadable()
    expect(loadWrappedKey(DAEMON, 'ws-1')).toEqual(BLOB)
  })

  const rawRecord = () =>
    JSON.parse(localStorage.getItem('whiteboard:replica-sealed-keys') ?? '{}') as Record<
      string,
      unknown
    >

  it('keeps them, byte for byte in storage, when another key is saved', () => {
    seedWithUnreadable()
    saveWrappedKey(OTHER, 'ws-2', BLOB)
    expect(loadWrappedKey(DAEMON, 'ws-1')).toEqual(BLOB)
    expect(rawRecord()['from-a-newer-build']).toEqual({ ...BLOB, addedByANewerBuild: true })
  })

  it('keeps them when another key is dropped', () => {
    seedWithUnreadable()
    dropWrappedKey(DAEMON, 'ws-1')
    expect(rawRecord()).toEqual({
      'from-a-newer-build': { ...BLOB, addedByANewerBuild: true },
    })
  })

  it('lets a save replace an unreadable entry under its own key', () => {
    seedWithUnreadable()
    const key = `${DAEMON}\u0000ws-1`
    const raw = rawRecord()
    localStorage.setItem(
      'whiteboard:replica-sealed-keys',
      JSON.stringify({ ...raw, [key]: { ...BLOB, addedByANewerBuild: true } }),
    )
    expect(loadWrappedKey(DAEMON, 'ws-1')).toBeNull()

    saveWrappedKey(DAEMON, 'ws-1', BLOB)

    expect(rawRecord()[key]).toEqual(BLOB)
  })

  it('removes an unreadable entry when its own key is dropped', () => {
    const key = `${DAEMON}\u0000ws-1`
    localStorage.setItem(
      'whiteboard:replica-sealed-keys',
      JSON.stringify({ [key]: { ...BLOB, addedByANewerBuild: true } }),
    )

    dropWrappedKey(DAEMON, 'ws-1')

    expect(rawRecord()).toEqual({})
  })
})
