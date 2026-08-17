import { userInfo } from 'node:os'
import type { WebSocket } from 'ws'
import { corruptStoredDataBody } from '../../store/corrupt-stored-data.js'

// WS broadcast function injected from ws.ts. Held behind get/set indirection
// (rather than a plain export) because ws.ts registers the real
// implementation only after both modules have finished loading, breaking the
// canvas <-> ws import cycle.
export type BroadcastFn = (
  workspaceId: string,
  path: string,
  update: Uint8Array,
  excludeWs?: WebSocket,
) => void

let broadcastLoroUpdate: BroadcastFn = () => {}

export function setBroadcastFn(fn: BroadcastFn): void {
  broadcastLoroUpdate = fn
}

export function getBroadcastFn(): BroadcastFn {
  return broadcastLoroUpdate
}

export function defaultHumanDisplayName(): string {
  try {
    const name = userInfo().username.trim()
    if (name.length > 0) return name
  } catch {
    /* ignore */
  }
  return 'human'
}

export function handleCorruptStoredData(
  err: unknown,
): { status: 500; body: { error: 'corrupt_stored_data'; message: string } } | null {
  const body = corruptStoredDataBody(err)
  if (body) return { status: 500, body }
  return null
}
