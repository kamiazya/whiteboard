/**
 * What `clearWhiteboardDb` promises when it resolves.
 *
 * The contract is one sentence — once it resolves, the database is gone —
 * and it is the whole reason the helper is awaited in a `beforeEach`. A
 * version that settles while the deletion is still BLOCKED breaks it
 * silently: the next test seeds a fixture into rows the previous one left
 * behind, or reads a database that is being deleted underneath it, and the
 * failure surfaces two files away as a page that could not read its own
 * data.
 *
 * That is not hypothetical. It is the shape behind a flake that hit
 * `BrowserDocumentPage.rename` and then `BrowserDocumentPage.delete-confirm`
 * with an identical symptom: the editor replaced by "This canvas's data could
 * not be read." — a failure whose message names neither IndexedDB nor the
 * test that actually broke the invariant.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { whiteboardDbName } from '../lib/browser-idb.js'
import { clearWhiteboardDb } from './browser-document.js'
import { claimIsolatedWhiteboardDb } from './isolated-whiteboard-db.js'

const ISOLATED_DB = claimIsolatedWhiteboardDb('clear-whiteboard-db')

/** Opens the database and hands back the connection, still open. */
async function openHeld(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(ISOLATED_DB)
    req.onupgradeneeded = () => req.result.createObjectStore('held')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function databaseExists(): Promise<boolean> {
  return (await indexedDB.databases()).some((one) => one.name === ISOLATED_DB)
}

/**
 * Drives one blocked deletion and reports the ORDER of what happened.
 *
 * Eventual state cannot tell the two behaviours apart, which is the trap
 * this replaced: a helper that resolves the moment `blocked` fires still
 * leaves a database that is gone a tick later, because the blocking
 * connection closes and the deletion completes on its own. Asking
 * `databaseExists()` afterwards therefore answers `false` either way, and
 * reads exactly like a guard.
 *
 * What differs is WHEN the helper resolves. So the blocker is closed from a
 * `setTimeout` inside the `blocked` handler — a macrotask, which every
 * promise resolution from that same event beats — and the sequence is the
 * assertion.
 *
 * `addEventListener` rather than assigning `onblocked`, so the helper's own
 * handler is left exactly as it is. Reporting `blocked` itself is what keeps
 * the case honest: if the deletion was never blocked, the helper was never
 * asked the question and the green means nothing.
 */
async function orderOfOneBlockedDeletion(held: IDBDatabase): Promise<string[]> {
  const real = indexedDB.deleteDatabase.bind(indexedDB)
  const order: string[] = []
  indexedDB.deleteDatabase = (name: string) => {
    const req = real(name)
    req.addEventListener('blocked', () => {
      order.push('blocked')
      setTimeout(() => {
        order.push('closed the blocker')
        held.close()
      }, 0)
    })
    return req
  }
  try {
    await clearWhiteboardDb()
    order.push('resolved')
  } finally {
    indexedDB.deleteDatabase = real
  }
  return order
}

afterEach(async () => {
  await clearWhiteboardDb()
})

describe('clearWhiteboardDb', () => {
  it('is about the database this file claimed, not the shared one', () => {
    expect(whiteboardDbName()).toBe(ISOLATED_DB)
  })

  it('deletes a database nothing is holding open', async () => {
    ;(await openHeld()).close()
    expect(await databaseExists()).toBe(true)

    await clearWhiteboardDb()

    expect(await databaseExists()).toBe(false)
  })

  it('waits out a blocked deletion instead of resolving over it', async () => {
    // The whole contract: when this resolves, the database is gone. A
    // version that settles on `blocked` hands the next test a database it
    // was told had been cleared — which is how a fixture ends up seeded on
    // top of the previous file's rows, and how the failure surfaces two
    // files away as a page that cannot read its own data.
    const held = await openHeld()

    expect(await orderOfOneBlockedDeletion(held)).toEqual([
      'blocked',
      'closed the blocker',
      'resolved',
    ])
    expect(await databaseExists()).toBe(false)
  })
})
