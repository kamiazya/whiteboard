import type { LoroDoc } from 'loro-crdt'
import { getLogger } from '../../log.js'
import { isCorruptStoredDataError } from '../../store/corrupt-stored-data.js'
import type { OperatorInfo, VersionEntry, VersionStore } from '../../store/version-store.js'

// Shared auto-version debounce trigger used by both HTTP POST /update and the WS binary path.
// Tracks the last auto-save time per documentId and returns no-op below the threshold.
export const AUTO_VERSION_INTERVAL_MS = 30_000

export function createAutoVersionTrigger(
  versionStore: VersionStore,
  intervalMs: number,
  // Resolve the current HEAD branch name at save time and write it into VersionMeta.branchName.
  // If omitted or null, keep the previous behavior and let VersionStore.save fall back to "main".
  getHeadBranch?: (workspaceId: string, path: string) => Promise<string | null>,
): (workspaceId: string, path: string, doc: LoroDoc) => Promise<VersionEntry | null> {
  // Per-canvas last-save timestamps. In-place Map mutation is intentional: this is
  // closure-private throttle state, never shared or observed, so the immutability
  // rule (which guards shared/observable data) does not apply.
  const lastAt = new Map<string, number>()
  return async function triggerAutoVersion(workspaceId, path, doc) {
    const key = `${workspaceId}/${path}`
    const now = Date.now()
    if (now - (lastAt.get(key) ?? 0) < intervalMs) return null
    let branchName: string | null = null
    if (getHeadBranch) {
      try {
        branchName = await getHeadBranch(workspaceId, path)
      } catch (err) {
        if (isCorruptStoredDataError(err)) {
          throw err
        }
        branchName = null
      }
    }
    try {
      const opts: { auto: boolean; branchName?: string; operator: OperatorInfo } = {
        auto: true,
        operator: {
          kind: 'system',
          peerId: doc.peerIdStr,
          displayName: 'auto-save',
        },
      }
      if (typeof branchName === 'string' && branchName.length > 0) {
        opts.branchName = branchName
      }
      const entry = await versionStore.save(workspaceId, path, doc, opts)
      lastAt.set(key, now)
      return entry
    } catch (err) {
      getLogger('auto-version').error({ err: err as Error }, 'save failed')
      return null
    }
  }
}
