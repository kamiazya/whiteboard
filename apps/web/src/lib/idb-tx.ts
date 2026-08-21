/**
 * The two helpers every IndexedDB-backed port implementation needs.
 *
 * Extracted from `idb-document-index.ts` when the blob store became the
 * second one: a port's atomicity guarantee is bought by the shape of these
 * two functions, and two copies of that shape is two chances to buy it
 * slightly differently.
 */

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
