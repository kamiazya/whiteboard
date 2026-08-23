/**
 * The two helpers every IndexedDB-backed port implementation needs.
 *
 * Extracted from `idb-document-index.ts` when the blob store became the
 * second one: a port's atomicity guarantee is bought by the shape of these
 * two functions, and two copies of that shape is two chances to buy it
 * slightly differently.
 */

import { z } from 'zod'
import { openWhiteboardDb } from './browser-idb.js'

/** One IndexedDB request as a promise. */
export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/**
 * Runs `body` inside one transaction and resolves once that transaction
 * COMMITS, not once `body` returns. The difference is the whole point: an
 * `await` that settles on the last request leaves the caller free to observe
 * a write the browser has not committed, and a later abort would then
 * contradict something the caller already acted on.
 *
 * An error thrown by `body` aborts the transaction, so a refusal (a taken
 * path, a missing workspace) leaves nothing behind.
 */
export async function inTransaction<T>(
  dbName: string | undefined,
  stores: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openWhiteboardDb(dbName)
  try {
    const tx = db.transaction(stores, mode)
    const committed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'))
    })
    let result: T
    try {
      result = await body(tx)
    } catch (err) {
      tx.abort()
      // Swallowed: the abort's own rejection is the same failure arriving by
      // a second route, and reporting it would replace the real cause.
      committed.catch(() => {})
      throw err
    }
    await committed
    return result
  } finally {
    db.close()
  }
}

/**
 * A `Uint8Array` that came back OUT of IndexedDB.
 *
 * `instanceof` is the wrong test here and it fails silently. IndexedDB returns
 * values through structured clone, and an implementation may build them in a
 * different realm — measured under `fake-indexeddb` in jsdom, where a stored
 * `Uint8Array` reads back with `constructor.name === 'Uint8Array'` and
 * `value instanceof Uint8Array === false`. A schema gated on `instanceof` then
 * rejects a perfectly good record as corrupt, and every document in the
 * database reads as damaged.
 *
 * `Object.prototype.toString` asks the internal brand instead, which crosses
 * realms. The value is COPIED rather than passed through, so everything
 * downstream — `loro.import` included — gets an array from this realm.
 */
export const storedBytesSchema = z
  .custom<Uint8Array>((value) => Object.prototype.toString.call(value) === '[object Uint8Array]', {
    message: 'expected stored bytes',
  })
  .transform((value) => new Uint8Array(value as Uint8Array))
