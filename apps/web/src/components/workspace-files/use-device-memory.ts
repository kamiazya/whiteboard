import { useCallback, useMemo, useRef, useState } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { readRecentIds, recordRecentDocument } from '../../lib/recent-documents.js'
import { readSeenDigest, recordSeenDocument } from '../../lib/seen-documents.js'

/**
 * What THIS DEVICE remembers about a workspace, and what the picker draws
 * from it: the recently-opened lane, and the dot on a card whose content
 * moved since the last time this device opened it.
 *
 * One hook rather than two because both are written at the same instant — an
 * open — and read by the same render. They are STORED apart
 * (`recent-documents.ts` is an ordered list capped at a handful,
 * `seen-documents.ts` a per-document map), which is a difference that
 * matters and is not this hook's to flatten: a digest riding on the lane
 * would lose its dot the moment the document fell off the end of it.
 *
 * Both are per-device and unsynced by decision (owner, 2026-09-05): what
 * this device opened is a fact about this device, so a phone and a desktop
 * disagreeing is correct rather than a gap — and it keeps both out of the
 * document model entirely.
 */
export interface DeviceMemory {
  /** Most recent first, for the lane. Empty until a workspace handle exists. */
  recentIds: readonly string[]
  /**
   * The documents whose content differs from what this device last opened.
   *
   * `undefined` while there is nothing to compare against — no listing yet,
   * or no workspace handle — which the grid renders as no dots at all rather
   * than as "nothing changed".
   */
  changed: ReadonlySet<string> | undefined
  /** Record an open. Stable identity: the panel hands it to four children. */
  remember: (entry: WorkspaceDocumentEntry) => void
  /** SCOPE RESET — see scoped-screen-state.test.ts */
  reset: () => void
}

export function useDeviceMemory(
  workspace: string | undefined,
  documents: readonly WorkspaceDocumentEntry[] | null,
): DeviceMemory {
  const [recentIds, setRecentIds] = useState<readonly string[]>([])
  /**
   * Bumped when this hook records a baseline, so `changed` recomputes.
   * Storage is not reactive and this is the only writer in the tab, so a
   * counter is the whole subscription.
   */
  const [seenRevision, setSeenRevision] = useState(0)
  // Read at CALL time, so `remember` and `reset` keep a stable identity.
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace

  const remember = useCallback((entry: WorkspaceDocumentEntry) => {
    const scope = workspaceRef.current
    if (scope === undefined) return
    recordRecentDocument(scope, entry.documentId)
    setRecentIds(readRecentIds(scope))
    // Only when the keeper derived a digest: a row without one has nothing
    // to compare later, and a missing baseline must read as "no dot" rather
    // than as "changed".
    if (entry.contentDigest !== undefined) {
      recordSeenDocument(scope, entry.documentId, entry.contentDigest)
      setSeenRevision((revision) => revision + 1)
    }
  }, [])

  /**
   * Compared on `contentDigest`, never `updatedAt`: `document-entry.ts`
   * records the measurement that a merge does not consult the stamp, so a
   * signal built on it can call a document unchanged in the one case this
   * dot exists for — something rewriting it while the person was elsewhere.
   */
  const changed = useMemo(() => {
    if (documents === null || workspace === undefined) return undefined
    const marked = new Set<string>()
    for (const entry of documents) {
      if (entry.contentDigest === undefined) continue
      const seen = readSeenDigest(workspace, entry.documentId)
      if (seen !== undefined && seen !== entry.contentDigest) marked.add(entry.documentId)
    }
    return marked
    // `seenRevision` is not read by the body — it is the signal that this
    // hook wrote a baseline, which is the only way the answer changes
    // without `documents` changing too.
  }, [documents, workspace, seenRevision])

  const reset = useCallback(() => {
    // SCOPE RESET — see scoped-screen-state.test.ts
    // Emptied and refilled together, from the CURRENT handle. Two effects
    // doing one half each made the ORDER load-bearing, and it was wrong: the
    // load ran first and the reset blanked it, so the lane never survived a
    // remount.
    setRecentIds([])
    const scope = workspaceRef.current
    if (scope !== undefined) setRecentIds(readRecentIds(scope))
  }, [])

  return { recentIds, changed, remember, reset }
}
