/**
 * Everything the shared document page reads from its KEEPER.
 *
 * ADR-0004 decided one page with capability-gated chrome and a controller
 * selected per keeper. What the two pages had in common — the shell, the
 * inspector beside the editor (properties, comments, connections, history),
 * the file and reference seams, the editor surface, the document actions
 * row — is rendered once, in `DocumentPage`. What differs is not the chrome but its SUPPLY: where the
 * document's facts come from, how a write travels, which store keeps the
 * versions. This model is that supply, so a keeper answers it and the page
 * never asks which keeper it is talking to.
 *
 * Slots carry the chrome only one keeper has today, placed by the page at
 * a named position rather than by a keeper branch inside it.
 */
import type { DocumentKind, SpatialCanvas, StoredCoreFacets } from '@kamiazya/whiteboard-model'
import type { ComponentProps, ReactNode, RefObject } from 'react'
import type { ConnectionsPanelProps } from '../components/connections/ConnectionsChip.js'
import type { MarkdownDocumentSession } from '../components/document-editor/DocumentEditorSurface.js'
import type { SpatialEditorPaneProps } from '../components/document-editor/SpatialEditorPane.js'
import type { VersionPanel } from '../components/workspace-top-bar/VersionPanel.js'
import type { CommentsRailWrite } from '../hooks/use-comments-rail.js'
import type { UseDocumentFileSeamsOptions } from '../hooks/use-document-file-seams.js'
import type { ReferenceLoader } from '../hooks/use-reference-seams.js'
import type { UseDocumentSyncResult } from '../hooks/useDocumentSync.js'
import type { useWhiteboardCommands } from '../lib/commands/index.js'
import type { linkTargets } from '../lib/link-entries.js'
import type { WhiteboardCapabilities } from '../lib/provider.js'
import type { PastDocument, VersionsBackend } from '../lib/versions-backend.js'

export interface DocumentPageModel {
  /**
   * Names the document on screen. Every document-scoped piece of page state
   * (the open history column, an armed bookmark, a version being looked at)
   * resets when it changes — the page switches documents without remounting.
   */
  readonly scopeKey: string | null
  /** Keys the editor and the title row to the document identity. */
  readonly documentKey: string
  readonly documentKind: DocumentKind
  readonly srTitle: string
  readonly capabilities: WhiteboardCapabilities
  /** The live sync session; the backend behind it is the keeper's. */
  readonly sync: UseDocumentSyncResult
  readonly markdown: Pick<
    MarkdownDocumentSession,
    'body' | 'setBody' | 'meta' | 'sourceExtensions' | 'autoFocus' | 'title'
  > & {
    /**
     * True while nothing editable may render yet — the keeper has the body
     * but not its facets, or neither. The surface then mounts its
     * placeholder instead of an editor bound to a half-hydrated document.
     */
    readonly hydrating: boolean
  }
  /**
   * The document's name in the title row. A keeper that names documents
   * through its own store answers with the value and the rename; one that
   * leaves naming to the top bar's identity answers `'top-bar'`.
   */
  readonly title: { readonly value: string; readonly onChange: (next: string) => void } | 'top-bar'
  readonly properties: {
    /** False while the row must not render yet (the browser's facets have not hydrated). */
    readonly ready: boolean
    readonly facets?: StoredCoreFacets
    readonly onFacetsChange?: (next: StoredCoreFacets) => void
    /** Hidden persistence facts for tests; the row shows no save state. */
    readonly status?: ReactNode
  }
  /**
   * The documents linking here, for the inspector's Connections panel and
   * its opener. Absent for a keeper that answers no backlinks (the browser);
   * `backlinks: null` while the daemon's answer is in flight.
   */
  readonly connections?: Omit<ConnectionsPanelProps, 'backlinks'> & {
    readonly backlinks: ConnectionsPanelProps['backlinks'] | null
  }
  readonly threads: {
    readonly annotations: UseDocumentSyncResult['annotations']
    /** Where the CRDT still holds each passage; only a body has one, so a note's keeper may answer none. */
    readonly threadMarks: UseDocumentSyncResult['threadMarks'] | undefined
    readonly write: CommentsRailWrite
    /** The canvas the rail resolves spatial anchors against; null for a note. */
    readonly railCanvas: SpatialCanvas | null
  }
  readonly files: Pick<UseDocumentFileSeamsOptions, 'adapter' | 'stampOf'> & {
    readonly resolveAlias: NonNullable<UseDocumentFileSeamsOptions['resolveAlias']>
    readonly resolveTitle: NonNullable<UseDocumentFileSeamsOptions['resolveTitle']>
    readonly missingFileRef: SpatialEditorPaneProps['missingFileRef']
    readonly pickerTargets: ReturnType<typeof linkTargets>
    readonly loadReference?: ReferenceLoader
  }
  /** Following a reference: the id it names, the keeper's own way to get there. */
  readonly openDocument: (id: string) => void
  readonly overlayTitle: string
  readonly exportFilenameBase: string
  readonly commands: Parameters<typeof useWhiteboardCommands>[0] & {
    /** Keys the WebMCP tool registration to the document; null unregisters. */
    readonly registryKey: string | null
  }
  readonly versions: {
    /** Whether this document has a history to open; gates the column and ⌘S. */
    readonly enabled: boolean
    readonly workspaceId: string
    readonly path: string
    readonly historyCapabilities: ComponentProps<typeof VersionPanel>['capabilities']
    /** Where a bookmark's picture goes; null when this keeper has no history for the document. */
    readonly backend: Pick<VersionsBackend, 'putThumbnail'> | null
    readonly save: (
      label: string,
    ) => Promise<{ workspaceId: string; path: string; versionId: string }>
    /**
     * The beat after a save that re-reads the history column. A keeper that
     * announces on the window fires the event the page already listens to;
     * one that has no such bus raises the page's `onVersionCreated` directly.
     */
    readonly announceRefresh: () => void
    readonly announceOnce?: () => void
  }
  /** The merged header row; null while there is no document to name in it. */
  readonly topBar: {
    readonly workspaceId: string
    readonly path: string
    readonly dataMode?: 'daemon' | 'local'
    readonly onNavigateBack?: () => void
    readonly branchRefreshSignal?: number
    readonly onPreviewVariation?: (name: string) => void
  } | null
  /** A read-only state drawn in place of the editor that is not a version (a variation's tip). */
  readonly readOnlyPast: PastDocument | null
  readonly spatial: Pick<SpatialEditorPaneProps, 'editorRef' | 'agentTouchedNodeIds' | 'children'>
  readonly slots: {
    /** Alerts in the document actions row, before the ⋯ menu. */
    readonly rowAlerts?: ReactNode
    /** Items inside the document ⋯ menu, after Export. */
    readonly menuItems?: ReactNode
    readonly menuTriggerRef?: RefObject<HTMLButtonElement | null>
    /** After the ⋯ menu in the actions row (a confirm dialog). */
    readonly afterMenu?: ReactNode
    /** Header rows under the top bar (banners, notices, teasers). */
    readonly headerExtras?: ReactNode
    /** Rendered INSTEAD of the editor row (an empty state). */
    readonly replaceEditor?: ReactNode
    /** After the editor row, inside the shell (a toast). */
    readonly footer?: ReactNode
  }
}
