import { z } from 'zod'
import { openWhiteboardDb } from './browser-idb.js'
import { generateReconnectKeypair } from './reconnect-crypto.js'

/**
 * Persists the WebCrypto ECDSA P-256 keypair used for silent-reconnect
 * challenge-response, keyed by origin, in the 'reconnectKeypairs' IndexedDB
 * object store. A non-extractable CryptoKeyPair is structured-clonable, so
 * both halves are stored directly rather than in some exported form — the
 * private key never leaves the browser's key store in any exportable shape.
 *
 * `status` distinguishes a key that has been generated and enrolled with the
 * daemon ('pending') from one a challenge-response login has actually proven
 * usable end-to-end ('confirmed') — see reconnect-enrollment.ts /
 * useSilentReconnect.ts for the crash-safe ordering this supports.
 */
const keypairRecordSchema = z.object({
  v: z.literal(1),
  origin: z.string(),
  // Identifies THIS generated key, independent of the CryptoKey object
  // identity (which cannot be compared across a reload or another tab).
  // Lets a caller compare-and-delete: only remove the record if it still
  // holds the exact key an earlier operation observed, rather than
  // unconditionally deleting whatever now occupies the origin slot — see
  // clearKeypairIfMatches.
  keyId: z.string().min(1),
  status: z.enum(['pending', 'confirmed']),
  publicKey: z.instanceof(CryptoKey),
  privateKey: z.instanceof(CryptoKey),
})

export type ReconnectKeypairRecord = z.infer<typeof keypairRecordSchema>

const STORE_NAME = 'reconnectKeypairs'

function isConstraintError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'ConstraintError'
}

/**
 * Reads the stored keypair record for `origin`, or null when absent/corrupt.
 *
 * A schema-invalid row (a stale/half-written record from a previous app
 * version, or manual tampering) is deleted rather than merely ignored: a
 * readonly transaction can't write, and returning null without clearing the
 * row would leave it in place under the origin key — getOrCreateKeypair's
 * subsequent add() would then hit a ConstraintError forever, permanently
 * blocking silent-reconnect enrollment for that origin.
 */
export async function loadKeypair(origin: string): Promise<ReconnectKeypairRecord | null> {
  const db = await openWhiteboardDb()
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(STORE_NAME, 'readwrite')
    } catch (err) {
      db.close()
      reject(err)
      return
    }
    const store = tx.objectStore(STORE_NAME)
    const req = store.get(origin)
    req.onsuccess = () => {
      if (req.result === undefined) {
        resolve(null)
        return
      }
      const parsed = keypairRecordSchema.safeParse(req.result)
      if (parsed.success) {
        resolve(parsed.data)
        return
      }
      store.delete(origin)
      resolve(null)
    }
    req.onerror = () => reject(req.error)
    tx.oncomplete = () => db.close()
    tx.onerror = () => db.close()
    tx.onabort = () => db.close()
  })
}

function addRecord(db: IDBDatabase, record: ReconnectKeypairRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(STORE_NAME, 'readwrite')
    } catch (err) {
      db.close()
      reject(err)
      return
    }
    tx.objectStore(STORE_NAME).add(record)
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    // Deliberately no request- or transaction-level onerror handler: leaving
    // add()'s ConstraintError unhandled lets its DEFAULT action run, which is
    // to abort the transaction — exactly what getOrCreateKeypair's recovery
    // path needs. Calling preventDefault() (the usual idiom for a read this
    // caller expects to sometimes fail) would instead let the transaction
    // complete as if the write had succeeded, silently NOT persisting the
    // record while this call still resolves — the two-tab race would then
    // diverge onto different keys instead of converging on one.
    tx.onabort = () => {
      db.close()
      reject(tx.error ?? new Error('reconnect-keypair-store: add() transaction aborted'))
    }
  })
}

/**
 * Returns the existing keypair for `origin` if one is already stored,
 * otherwise generates a fresh one and persists it as 'pending'.
 *
 * Deliberately generate-then-add rather than check-then-generate: two tabs
 * racing to enroll the same origin both generate a key and both call add(),
 * but IndexedDB's origin-keyed uniqueness means only the first add() can
 * succeed — the loser recovers by discarding its freshly generated key and
 * loading the winner's, so the two tabs converge on a single stored keypair
 * instead of each enrolling (and the daemon silently overwriting) a
 * different one.
 */
export async function getOrCreateKeypair(origin: string): Promise<ReconnectKeypairRecord> {
  const existing = await loadKeypair(origin)
  if (existing) return existing

  const { publicKey, privateKey } = await generateReconnectKeypair()
  const record: ReconnectKeypairRecord = {
    v: 1,
    origin,
    keyId: crypto.randomUUID(),
    status: 'pending',
    publicKey,
    privateKey,
  }

  const db = await openWhiteboardDb()
  try {
    await addRecord(db, record)
    return record
  } catch (err) {
    if (!isConstraintError(err)) throw err
    const winner = await loadKeypair(origin)
    if (winner) return winner
    throw err
  }
}

/**
 * Get-then-put inside a single readwrite transaction, only writing `status`
 * when the stored record still matches `keyId` — guards the same cross-tab
 * race `clearKeypair` guards against: a late status update for a key another
 * tab has already superseded must not touch the replacement it enrolled.
 */
function putStatusIfMatches(
  origin: string,
  keyId: string,
  status: ReconnectKeypairRecord['status'],
): Promise<void> {
  return (async () => {
    const db = await openWhiteboardDb()
    return new Promise<void>((resolve, reject) => {
      let tx: IDBTransaction
      try {
        tx = db.transaction(STORE_NAME, 'readwrite')
      } catch (err) {
        db.close()
        reject(err)
        return
      }
      const store = tx.objectStore(STORE_NAME)
      const getReq = store.get(origin)
      getReq.onsuccess = () => {
        const existing = getReq.result as ReconnectKeypairRecord | undefined
        if (existing === undefined || existing.keyId !== keyId) {
          // Already cleared, or superseded by a different key — nothing to update.
          return
        }
        store.put({ ...existing, status })
      }
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
      tx.onabort = () => {
        db.close()
        reject(tx.error ?? new Error('transaction aborted'))
      }
    })
  })()
}

/**
 * Marks `origin`'s keypair 'confirmed' after a successful challenge-response
 * login, but ONLY if it still matches `keyId` — the exact key the caller
 * proved usable, not merely whatever now occupies the origin slot.
 */
export function markKeypairConfirmed(origin: string, keyId: string): Promise<void> {
  return putStatusIfMatches(origin, keyId, 'confirmed')
}

/**
 * Deletes `origin`'s stored keypair, but ONLY if it still matches `keyId` —
 * guards a cross-tab race where a rejection for the KEY THIS CALLER LOADED
 * is handled after another tab already cleared it and enrolled a
 * replacement: an unconditional delete would erase that newer, unrelated
 * keypair instead of the one that was actually rejected. Get-then-delete
 * inside a single readwrite transaction, so no concurrent write can land
 * between the identity check and the delete.
 */
export async function clearKeypair(origin: string, keyId: string): Promise<void> {
  const db = await openWhiteboardDb()
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(STORE_NAME, 'readwrite')
    } catch (err) {
      db.close()
      reject(err)
      return
    }
    const store = tx.objectStore(STORE_NAME)
    const getReq = store.get(origin)
    getReq.onsuccess = () => {
      const existing = getReq.result as ReconnectKeypairRecord | undefined
      if (existing !== undefined && existing.keyId === keyId) {
        store.delete(origin)
      }
    }
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error)
    }
    tx.onabort = () => {
      db.close()
      reject(tx.error ?? new Error('transaction aborted'))
    }
  })
}
