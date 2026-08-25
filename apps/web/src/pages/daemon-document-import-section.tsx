import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { useState } from 'react'
import { ImportFromBrowserPanel } from '../components/migration/ImportFromBrowserPanel.js'
import type { ContentClock } from '../lib/local-document-summary.js'
import { type LoroLoadResult, LoroStore } from '../lib/loro-store.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'
import { loadWorkspaceDocumentProjection } from '../lib/workspace-content.js'

export interface DaemonDocumentImportSectionProps {
  workspaceId: string
  daemonFetch: typeof fetch
  daemonBaseUrl?: string
  browserStore: DocumentIndex
  browserClock?: ContentClock
}

/**
 * What the import panel reads a document's bytes through: the workspace
 * document's tree node first — that is where an edited document's CURRENT
 * state lives — and the legacy per-document record for anything unfolded.
 * Without the tree read, an import would ship the pre-fold copy of every
 * document edited since the workspace-document cutover.
 */
function workspaceFirstImportStore(): { load(documentId: string): Promise<LoroLoadResult> } {
  const legacy = new LoroStore()
  return {
    async load(documentId: string): Promise<LoroLoadResult> {
      const projected = await loadWorkspaceDocumentProjection(documentId).catch(() => null)
      if (projected !== null) {
        return {
          kind: 'ok',
          snapshot: new Uint8Array(projected.export({ mode: 'snapshot' })),
        }
      }
      return legacy.load(documentId)
    },
  }
}

/**
 * Isolated in its own file (rather than inlined in DaemonDocumentPage) so this
 * module is the only static import path for LoroStore/user-settings-store/
 * ImportFromBrowserPanel — those only load once React resolves the lazy()
 * boundary around this component, keeping IndexedDB/Loro out of the daemon
 * page's own chunk for sessions that never open the import disclosure.
 */
export function DaemonDocumentImportSection({
  workspaceId,
  daemonFetch,
  daemonBaseUrl,
  browserStore,
  browserClock,
}: DaemonDocumentImportSectionProps) {
  // useState's lazy initializer guarantees exactly-once construction per
  // mount; useMemo may legally re-run and would reset the stores' state.
  const [loroStore] = useState(() => workspaceFirstImportStore())
  const [settingsStore] = useState(() => createUserSettingsStore())

  return (
    <ImportFromBrowserPanel
      workspaceId={workspaceId}
      daemonFetch={daemonFetch}
      daemonBaseUrl={daemonBaseUrl}
      browserStore={browserStore}
      browserClock={browserClock}
      loroStore={loroStore}
      settingsStore={settingsStore}
    />
  )
}
