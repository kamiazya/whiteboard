/**
 * `inTransaction`'s commit and abort semantics, against a real IndexedDB.
 *
 * Every browser store's atomicity rests on this wrapper, and each case below
 * pins one line of it that the stores' own suites cannot see: those suites
 * only ever drive transactions that commit, so a wrapper that answered
 * before the commit, skipped the abort, or never heard an abort would pass
 * them all. jsdom's fake-indexeddb is not the subject either — what matters is
 * when a real browser fires `complete`, `error` and `abort`.
 */

import { beforeEach, expect, it } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { BLOBS_STORE } from './browser-idb.js'
import { inTransaction, request } from './idb-tx.js'

const DB_NAME = claimIsolatedWhiteboardDb('idb-tx')

beforeEach(async () => {
  await clearWhiteboardDb()
})

function readKey(key: string): Promise<unknown> {
  return inTransaction(DB_NAME, [BLOBS_STORE], 'readonly', (tx) =>
    request(tx.objectStore(BLOBS_STORE).get(key)),
  )
}

it('rejects a write whose commit fails, after the body returned, and stores nothing', async () => {
  // The second `add` collides only once the body has already returned, so the
  // transaction's own outcome is the one place the failure can surface.
  const answer = inTransaction(DB_NAME, [BLOBS_STORE], 'readwrite', async (tx) => {
    const store = tx.objectStore(BLOBS_STORE)
    store.add({ v: 1 }, 'k')
    store.add({ v: 2 }, 'k')
    return 'answered'
  })

  await expect(answer).rejects.toThrow()
  expect(await readKey('k')).toBeUndefined()
})

it('a body that throws after a completed put leaves that key unwritten', async () => {
  const answer = inTransaction(DB_NAME, [BLOBS_STORE], 'readwrite', async (tx) => {
    await request(tx.objectStore(BLOBS_STORE).put({ v: 1 }, 'k'))
    throw new Error('refused after the write')
  })

  await expect(answer).rejects.toThrow('refused after the write')
  expect(await readKey('k')).toBeUndefined()
})

it('rejects rather than hangs on an abort that no failed request announces', async () => {
  let outcome: 'pending' | 'resolved' | 'rejected' = 'pending'
  inTransaction(DB_NAME, [BLOBS_STORE], 'readwrite', async (tx) => {
    await request(tx.objectStore(BLOBS_STORE).put({ v: 1 }, 'k'))
    // Nothing is pending, so only `abort` fires — the shape of a commit the
    // browser refuses for quota.
    tx.abort()
    return 'answered'
  }).then(
    () => {
      outcome = 'resolved'
    },
    () => {
      outcome = 'rejected'
    },
  )

  await expect.poll(() => outcome, { timeout: 3_000 }).toBe('rejected')
  expect(await readKey('k')).toBeUndefined()
})
