/**
 * What the browser keeper's page ANSWERS with, in pieces small enough to
 * read: which screen a non-editing state shows, what the page knows once a
 * snapshot has arrived, and the four model slots whose whole content is
 * decided by the document's KIND.
 *
 * A sibling module rather than more of `BrowserDocumentPage.tsx`, because
 * none of this is React state — every one is a pure function of what the
 * hook already holds, and the page is the only thing that has to be read in
 * one sitting.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { ConnectionsBacklink } from '../components/connections/ConnectionsPanel.js'
import { DocumentPageSkeleton } from '../components/DocumentPageSkeleton.js'
import { LoadDegradedView } from '../components/document-editor/LoadDegradedView.js'
import type { CommentsRailWrite } from '../hooks/use-comments-rail.js'
import { getAppLogger } from '../lib/app-logger.js'
import type { DocumentReadFailure } from '../lib/document-read-failure.js'
import {
  DOCUMENT_SYNC_VERSION_SAVED_EVENT,
  dispatchIdentityEvent,
} from '../lib/document-sync-types.js'
import type { VersionsBackend } from '../lib/versions-backend.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import type { BrowserPageState } from './browser-page-state.js'
import type { DocumentKeeperAnswer } from './document-keeper.js'
import type { DocumentPageModel } from './document-page-model.js'
import type { Connections } from './use-connections.js'
import type { MarkdownDocumentState } from './use-markdown-document.js'

/** The one control a terminal screen offers. */
function RecoveryButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent"
    >
      {label}
    </button>
  )
}

/**
 * The three states where the page answers with a SCREEN instead of a
 * document, or `null` when there is a document to draw.
 *
 * WHICH recovery `load-degraded` offers follows what the failure knows, and
 * getting it wrong is destructive rather than merely unhelpful: `Start fresh`
 * deletes the record, which is the right last resort for a document this
 * build cannot read, and the worst possible button for one whose read was
 * simply blocked — the data is intact and one click removes it. So the retry
 * is what an unavailable read gets, and it is the only affordance there.
 */
export function browserTerminalAnswer(
  renderState: BrowserPageState,
  backendError: DocumentReadFailure | string | null,
  startFresh: () => Promise<void> | void,
): { answer: DocumentKeeperAnswer } | { editing: Extract<BrowserPageState, { kind: 'editing' }> } {
  if (renderState.kind === 'load-degraded') {
    return {
      answer: {
        kind: 'terminal',
        node: (
          <LoadDegradedView message={renderState.message}>
            {backendError === 'read-unavailable' ? (
              <RecoveryButton label="Try again" onClick={() => window.location.reload()} />
            ) : (
              <RecoveryButton label="Start fresh" onClick={() => void startFresh()} />
            )}
          </LoadDegradedView>
        ),
      },
    }
  }

  if (renderState.kind === 'cleanup-completed') {
    return {
      answer: {
        kind: 'terminal',
        node: (
          <div
            data-testid="cleanup-completed"
            className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"
          >
            <p className="text-sm text-muted-foreground">Canvas removed.</p>
            <RecoveryButton label="Start fresh" onClick={() => void startFresh()} />
          </div>
        ),
      },
    }
  }

  if (renderState.kind === 'loading') {
    return { answer: { kind: 'terminal', node: <DocumentPageSkeleton label="Loading canvas" /> } }
  }

  return { editing: renderState }
}

/**
 * What the page knows about the document ONCE it is loaded — five reads that
 * each answered the same "is there a snapshot yet?" question separately.
 *
 * `documentKind` defaults to `'spatial'` rather than to null because the
 * editor it feeds has to pick a surface before a snapshot exists, and a
 * board is what an unloaded document is drawn as.
 */
export function loadedSnapshotOf(pageState: BrowserPageState): {
  documentId: string | null
  documentPath: string | null
  documentName: string | null
  documentKind: DocumentSnapshot['kind']
  updatedAt: DocumentSnapshot['updatedAt'] | null
} {
  if (pageState.kind !== 'editing') {
    return {
      documentId: null,
      documentPath: null,
      documentName: null,
      documentKind: 'spatial',
      updatedAt: null,
    }
  }
  const { snapshot } = pageState
  return {
    documentId: snapshot.documentId,
    documentPath: snapshot.path,
    documentName: snapshot.name,
    documentKind: snapshot.kind,
    updatedAt: snapshot.updatedAt,
  }
}

/**
 * The Properties panel's own two answers. `ready` is about the BODY having
 * arrived, not about the document existing: a board is ready the moment it
 * loads (it has no frontmatter to wait for), while a note is not ready until
 * both halves of its OKF document are in hand — showing the panel earlier
 * offers an empty form over a document whose facets are still loading.
 *
 * The facets themselves are spread-or-nothing for the same reason a spatial
 * canvas has no facets at all: a facet is OKF frontmatter, and JSON Canvas
 * has nowhere to put one (ADR-0009 decision 3).
 */
export function documentPropertiesSlot(
  documentKind: DocumentSnapshot['kind'],
  markdownDoc: Pick<MarkdownDocumentState, 'body' | 'coreFacets' | 'setCoreFacets'>,
): Pick<DocumentPageModel['properties'], 'ready' | 'facets' | 'onFacetsChange'> {
  if (documentKind !== 'markdown') return { ready: true }
  const ready = markdownDoc.body !== null && markdownDoc.coreFacets !== null
  if (markdownDoc.coreFacets === null) return { ready }
  return { ready, facets: markdownDoc.coreFacets, onFacetsChange: markdownDoc.setCoreFacets }
}

/**
 * The document list with THIS document's own snapshot in place of the copy
 * the list holds. The list read races the save a rename queues, so the
 * snapshot is the live truth and the list is only the copy for the OTHER
 * documents. Both the switcher and the link picker read this, or the picker
 * would offer a stale name for the document being edited — or omit it
 * entirely right after it was created.
 */
export function withLiveSnapshot(
  documents: readonly DocumentSnapshot[],
  pageState: BrowserPageState,
): readonly DocumentSnapshot[] {
  if (pageState.kind !== 'editing') return documents
  const { snapshot } = pageState
  const known = documents.some((entry) => entry.documentId === snapshot.documentId)
  if (!known) return [...documents, snapshot]
  return documents.map((entry) => (entry.documentId === snapshot.documentId ? snapshot : entry))
}

/**
 * The rail's write door for a NOTE. A board's is `spatialThreadWrite`, and
 * the page picks between them ONCE by document kind rather than asking per
 * method — four copies of the same question was how a fifth method could be
 * added and answered for one kind only.
 *
 * `editMessage` drops its `opening` argument here deliberately: a note's
 * thread has no anchor to re-open onto.
 */
export function markdownThreadWrite(markdownDoc: MarkdownDocumentState): CommentsRailWrite {
  return {
    createThread: (thread) => markdownDoc.createThread(thread),
    replyToThread: (threadId, message) => markdownDoc.replyToThread(threadId, message),
    setThreadStatus: (threadId, status) => markdownDoc.setThreadStatus(threadId, status),
    editMessage: (threadId, message) => markdownDoc.editMessage(threadId, message),
  }
}

/**
 * Everything the annotation layer READS, chosen once by document kind rather
 * than three times.
 *
 * A markdown document is given no `BrowserBackend` on purpose, so the sync
 * session it would speak through stays idle and its annotation channel
 * answers `[]` forever; the markdown hook reads the same document-level
 * `threads` plane off the host it already has, and from here down nothing
 * cares which of the two did the reading.
 *
 * `threadMarks` is where the CRDT still holds each passage — only a note has
 * a body for a mark to live in, so a board answers with nothing rather than
 * with the sync session's map, which is about a body it is not showing.
 * `railCanvas` is the opposite: only a board has one.
 */
export function conversationReads(
  documentKind: DocumentSnapshot['kind'],
  markdownDoc: MarkdownDocumentState,
  spatialAnnotations: DocumentPageModel['threads']['annotations'],
  canvas: SpatialCanvas,
): Pick<DocumentPageModel['threads'], 'annotations' | 'threadMarks' | 'railCanvas'> {
  if (documentKind !== 'markdown') {
    return { annotations: spatialAnnotations, threadMarks: undefined, railCanvas: canvas }
  }
  return {
    annotations: markdownDoc.annotations,
    threadMarks: markdownDoc.threadMarks,
    railCanvas: null,
  }
}

/**
 * The four places an UNNAMED document still has to be called something, in
 * one place. Each default differs because each surface differs: a React key
 * needs any stable string, an overlay needs a word a reader accepts, a
 * filename needs one a filesystem accepts, and the command registry needs an
 * id — so it answers `null` rather than inventing one.
 */
export function documentLabels(
  documentId: string | null,
  documentName: string | null,
): Pick<DocumentPageModel, 'documentKey' | 'overlayTitle' | 'exportFilenameBase'> & {
  commandCanvas: DocumentPageModel['commands']['canvas']
} {
  return {
    documentKey: documentId ?? 'no-canvas',
    overlayTitle: documentName ?? 'Untitled',
    exportFilenameBase: documentName ?? 'canvas',
    commandCanvas: documentId === null ? null : { documentId, name: documentName ?? '' },
  }
}

const log = getAppLogger('browser-document-page')

/**
 * The History column's slot: saving a version through this keeper's backend,
 * and announcing it the way the top bar listens.
 *
 * Null backend means nothing is loaded; the column is hidden then, so `save`
 * is never reached through it — it throws rather than guess a store.
 */
export function browserVersionsSlot({
  backend,
  workspaceId,
  path,
}: {
  backend: VersionsBackend | null
  workspaceId: string
  path: string
}): DocumentPageModel['versions'] {
  return {
    enabled: backend !== null,
    workspaceId,
    path,
    save: async (label) => {
      if (backend === null) throw new Error('saveVersionFromPanel: no versions backend')
      try {
        const saved = await backend.save(workspaceId, path, { label })
        return { workspaceId, path, versionId: saved.id }
      } catch (err) {
        log.warn('save version from the History panel failed', err)
        throw err
      }
    },
    // The top bar addresses this document as `local`/path (its
    // `dataMode="local"` placeholder), so the dot listens under that id.
    announceRefresh: () =>
      dispatchIdentityEvent(DOCUMENT_SYNC_VERSION_SAVED_EVENT, { workspaceId: 'local', path }),
  }
}

/**
 * The Connections chip's slot. `backlinks: null` while the first answer is
 * still being read, so the chip waits rather than claiming there are none.
 */
export function browserConnectionsSlot(
  connections: Connections | null,
  openDocument: (documentId: string) => void,
  linkify: (mention: ConnectionsBacklink) => void,
): Pick<DocumentPageModel, 'connections'> {
  return {
    connections: {
      backlinks: connections === null ? null : connections.backlinks,
      ...(connections === null ? {} : { mentions: connections.unlinkedMentions }),
      onOpen: (entry) => openDocument(entry.documentId),
      onLinkify: linkify,
    },
  }
}
