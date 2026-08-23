import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { useState } from 'react'
import { ImportFromBrowserPanel } from '../components/migration/ImportFromBrowserPanel.js'
import type { ContentClock } from '../lib/local-document-summary.js'
import { LoroStore } from '../lib/loro-store.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'

export interface DaemonDocumentImportSectionProps {
  workspaceId: string
  daemonFetch: typeof fetch
  daemonBaseUrl?: string
  browserStore: DocumentIndex
  browserClock?: ContentClock
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
  const [loroStore] = useState(() => new LoroStore())
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
