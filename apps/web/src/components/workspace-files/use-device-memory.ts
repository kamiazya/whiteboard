import { useCallback, useMemo, useRef, useState } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { readRecentIds, recordRecentDocument } from '../../lib/recent-documents.js'
import { readSeenDigest, recordSeenDocument } from '../../lib/seen-documents.js'
import type { WorkspaceIdentity } from '../../lib/workspace-handle.js'

/**
 * The scope both stores are kept under: WHO keeps the workspace, then its
 * canonical id.
 *
 * Never the address handle. Both keepers mint their first workspace under
 * the segment `default`, so a handle scope gave a browser workspace and a
 * daemon's one lane between them, and a segment is the layer a rename moves
 * (ADR-0019), so a renamed workspace started from an empty lane with every
 * "changed" baseline gone. The id is what survives a rename; the keeper
 * prefix is what keeps two keepers apart, and a daemon's base URL keeps two
 * daemons apart.
 */
export function browserMemoryScope(workspace: Pick<WorkspaceIdentity, 'workspaceId'>): string {
  return `browser:${workspace.workspaceId}`
}

export function daemonMemoryScope(
  daemonBaseUrl: string,
  workspace: Pick<WorkspaceIdentity, 'workspaceId'>,
): string {
  return `daemon:${daemonBaseUrl}:${workspace.workspaceId}`
}

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
  /** Most recent first, for the lane. Empty until a scope exists. */
  recentIds: readonly string[]
  /**
   * The documents whose content differs from what this device last opened.
   *
   * `undefined` while there is nothing to compare against — no listing yet,
   * or no scope — which the grid renders as no dots at all rather than as
   * "nothing changed".
   */
  changed: ReadonlySet<string> | undefined
  /** Record an open. Stable identity: the panel's `usePanelOpener` lists it in its callbacks' deps. */
  remember: (entry: WorkspaceDocumentEntry) => void
  /** SCOPE RESET — see scoped-screen-state.test.ts */
  reset: () => void
}

/** `scope` is `browserMemoryScope` / `daemonMemoryScope`; absent records nothing. */
export function useDeviceMemory(
  scope: string | undefined,
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
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  const remember = useCallback((entry: WorkspaceDocumentEntry) => {
    const current = scopeRef.current
    if (current === undefined) return
    recordRecentDocument(current, entry.documentId)
    setRecentIds(readRecentIds(current))
    // Only when the keeper derived a digest: a row without one has nothing
    // to compare later, and a missing baseline must read as "no dot" rather
    // than as "changed".
    if (entry.contentDigest !== undefined) {
      recordSeenDocument(current, entry.documentId, entry.contentDigest)
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
    if (documents === null || scope === undefined) return undefined
    const marked = new Set<string>()
    for (const entry of documents) {
      if (entry.contentDigest === undefined) continue
      const seen = readSeenDigest(scope, entry.documentId)
      if (seen !== undefined && seen !== entry.contentDigest) marked.add(entry.documentId)
    }
    return marked
    // `seenRevision` is not read by the body — it is the signal that this
    // hook wrote a baseline, which is the only way the answer changes
    // without `documents` changing too.
  }, [documents, scope, seenRevision])

  const reset = useCallback(() => {
    // SCOPE RESET — see scoped-screen-state.test.ts
    // Emptied and refilled together, from the CURRENT scope. Two effects
    // doing one half each made the ORDER load-bearing, and it was wrong: the
    // load ran first and the reset blanked it, so the lane never survived a
    // remount.
    setRecentIds([])
    const current = scopeRef.current
    if (current !== undefined) setRecentIds(readRecentIds(current))
  }, [])

  return { recentIds, changed, remember, reset }
}
