import { useCallback, useSyncExternalStore } from 'react'
import {
  sharedStreamFailed,
  subscribeSharedStreamFailure,
} from '../lib/sse-shared-stream-source.js'

/**
 * Whether the SharedWorker for this daemon origin failed to load. Flips once,
 * false to true, and a hook that built a connection on the worker keys that
 * connection on it: the worker's source is dead from then on, and building
 * again takes the own-stream path.
 */
export function useSharedStreamFailed(daemonBaseUrl: string): boolean {
  const read = useCallback(() => sharedStreamFailed(daemonBaseUrl), [daemonBaseUrl])
  return useSyncExternalStore(subscribeSharedStreamFailure, read, read)
}
