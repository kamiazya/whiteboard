import type { CrdtEngine } from './types.js'

let loaded: Promise<CrdtEngine> | undefined

/**
 * The one engine of this realm, loaded on first use and then shared.
 *
 * The engine module is imported here rather than at the top of the package
 * entry so a realm that holds the entry but never opens a document does not
 * run the wasm initialisation. A load that failed is asked for again by the
 * next call.
 */
export function loadCrdtEngine(): Promise<CrdtEngine> {
  loaded ??= import('./engine.js')
    .then(({ createCrdtEngine }) => createCrdtEngine())
    .catch((error: unknown) => {
      loaded = undefined
      throw error
    })
  return loaded
}
