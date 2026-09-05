import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import {
  CommentsRailAside,
  CommentsRailToggle,
} from '../components/annotations/CommentsRailChrome.js'
import { ConnectionsChip, ConnectionsPanel } from '../components/connections/ConnectionsChip.js'
import { DocumentPreview } from '../components/DocumentPreview.js'
import { DocumentEditorSurface } from '../components/document-editor/DocumentEditorSurface.js'
import { DocumentPageShell } from '../components/document-editor/DocumentPageShell.js'
import { InspectorPanel } from '../components/document-editor/InspectorPanel.js'
import { SpatialEditorPane } from '../components/document-editor/SpatialEditorPane.js'
import { useNodeInEditor } from '../components/document-editor/use-node-in-editor.js'
import {
  DocumentFacetsEditor,
  DocumentProperties,
} from '../components/document-properties/DocumentProperties.js'
import { CanvasDisplaySettings } from '../components/spatial-editor/CanvasDisplaySettings.js'
import type { VersionPreviewSession } from '../components/VersionTimeline'
import { BookmarkAction } from '../components/workspace-top-bar/BookmarkAction.js'
import { DocumentMenu } from '../components/workspace-top-bar/DocumentMenu.js'
import { sanitizeExportFilenameBase } from '../components/workspace-top-bar/export-filename.js'
import { useBookmarkShortcut } from '../components/workspace-top-bar/useBookmarkShortcut.js'
import { useSceneExport } from '../components/workspace-top-bar/useSceneExport.js'
import { VersionPanel } from '../components/workspace-top-bar/VersionPanel.js'
import { useCommentsRail } from '../hooks/use-comments-rail.js'
import { useDocumentFileSeams } from '../hooks/use-document-file-seams.js'
import { useFullscreen } from '../hooks/use-fullscreen.js'
import { useReferenceSeams } from '../hooks/use-reference-seams.js'
import { useThemeMode } from '../hooks/useThemeMode.js'
import { getAppLogger } from '../lib/app-logger.js'
import { captureBookmarkPicture } from '../lib/bookmark-picture.js'
import { useWhiteboardCommands } from '../lib/commands/index.js'
import type { InspectorKind } from '../lib/inspector.js'
import { fileRefOptions } from '../lib/link-entries.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'
import { cn } from '../lib/utils.js'
import { buildVersionSaveBody } from '../lib/version-save-body.js'
import { useBrowserToolRegistry } from '../lib/webmcp/use-browser-tool-registry.js'
import type { DocumentPageModel } from './document-page-model.js'
import { useVersionSaveFlow } from './use-version-save-flow.js'

// WorkspaceTopBar statically imports Radix, lucide, VersionTimeline,
// HeaderBranchChip and the Zod-validated daemon-client api-contracts. None
// of that weight is needed for a page's own entry chunk, so it loads as a
// sibling chunk. Kicked at page-module evaluation (this module is itself
// behind a lazy route), so it is a parallel prefetch, not a render-time
// chunk fetch — the merged row carries the title field and canvas
// operations, which must not wait for one.
const workspaceTopBarImport = import('../components/WorkspaceTopBar.js')
const WorkspaceTopBar = lazy(() => workspaceTopBarImport)

// Fixed height so the lazy WorkspaceTopBar chunk resolving after first paint
// causes no layout shift.
const TOP_BAR_FALLBACK_HEIGHT = 'h-12'

const log = getAppLogger('document-page')

/**
 * The document page, whoever keeps the document (ADR-0004 decision 1).
 *
 * Renders the shell, the merged header row, the editor surface and the
 * inspector beside it (properties, comments, connections or history) from a
 * `DocumentPageModel`, and owns the page state that names no keeper: which
 * inspector is open, which past state is being looked at, the
 * save-a-version flow, the seams the editor reads.
 * A keeper page builds the model — controller, sync backend, body, versions
 * — and renders this; nothing in here asks which keeper it is.
 */
export function DocumentPage({ model }: { model: DocumentPageModel }) {
  const { sync, documentKind, documentKey, versions, files, threads } = model

  // Stable across re-renders so the settings payload isn't re-read from
  // localStorage on every render. Owned here rather than threaded down from
  // App: useThemeMode already persists and applies the <html class="dark">
  // toggle itself, so there is no App-level state this page needs to share.
  const [settingsStore] = useState(() => createUserSettingsStore())
  const { resolvedTheme } = useThemeMode()

  // The one inspector slot beside the editor: the document's properties,
  // its conversations, the documents linking to it, or its history — never
  // two at once, which is what the header retune set out to end. Which
  // panel is open is how the reader looks rather than what at, so it
  // survives a document switch: everything a panel SAYS is document-scoped
  // and reset below or by the hook that owns it, and every panel reads the
  // document on screen.
  const [inspector, setInspector] = useState<InspectorKind | null>(null)
  const toggleInspector = (kind: InspectorKind) =>
    setInspector((open) => (open === kind ? null : kind))
  const setCommentsOpen = useCallback((open: boolean) => setInspector(open ? 'comments' : null), [])
  // Bumped by ⌘/Ctrl+S to open the column with its naming field ready. The
  // chord asks for a bookmark now; it does not take one.
  const [bookmarkArmed, setBookmarkArmed] = useState(0)
  // The past state the person is LOOKING at, drawn in place of the editor.
  // Read-only by construction — see DocumentPreview — so "look, then decide"
  // cannot turn into an edit against a state that is not the document's.
  const [preview, setPreview] = useState<VersionPreviewSession | null>(null)
  useBookmarkShortcut(versions.enabled, () => {
    setInspector('history')
    setBookmarkArmed((n) => n + 1)
  })

  // SCOPE RESET — see scoped-screen-state.test.ts. Everything above but the
  // inspector slot names a document, and none of it may outlive the document
  // it is about. The save outcome and the comments rail's selection clear
  // themselves, keyed on the same scope.
  useEffect(() => {
    setBookmarkArmed(0)
    setPreview(null)
  }, [model.scopeKey])

  // Mirrors the scope itself, rewritten every render: an async save that
  // started under one document has to ask who is on screen NOW.
  const currentScopeRef = useRef(model.scopeKey)
  currentScopeRef.current = model.scopeKey

  // A save the History column itself offers. The top bar's dot and ⌘/Ctrl+S
  // are the other two routes; on a phone the shortcut is nothing and the dot
  // is small, so the column a finger opens has to carry one too.
  const {
    saving: savingVersion,
    outcome: saveVersionOutcome,
    run: runVersionSave,
  } = useVersionSaveFlow(currentScopeRef, model.scopeKey, async (label) => {
    // Narrowed by the precondition in `saveVersionFromPanel` below, which
    // never calls `run` (so never reaches this body) while history is off.
    if (versions.backend === null) {
      throw new Error('saveVersionFromPanel: this keeper has no history for the document')
    }
    // The shared body pins the beats: capture BEFORE the save, announce,
    // thumbnail riding along unawaited, re-announce once the picture lands
    // (see buildVersionSaveBody). Which pipeline draws the picture follows
    // the KIND — asking the spatial exporter for a markdown document drew
    // an empty box on every markdown version row.
    return buildVersionSaveBody({
      capture: () =>
        captureBookmarkPicture(documentKind, {
          exportScene: sync.exportScene,
          body: model.markdown.body,
        }),
      save: versions.save,
      backend: versions.backend,
      announceRefresh: versions.announceRefresh,
      ...(versions.announceOnce === undefined ? {} : { announceOnce: versions.announceOnce }),
      onThumbnailFailed: () => log.warn('bookmark thumbnail failed'),
    })(label)
  })
  const saveVersionFromPanel = async (label: string): Promise<void> => {
    if (!versions.enabled) return
    await runVersionSave(label)
  }

  // Only a markdown document has a body for a mark to live in; the spatial
  // side answers with nothing rather than with a body it is not showing.
  const markdownBody = documentKind === 'markdown' ? model.markdown.body : null

  // The rail's write door is the keeper's: its writes lead to whichever
  // document holds the threads, and only the keeper knows which that is.
  const commentsRail = useCommentsRail({
    scopeKey: model.scopeKey,
    open: inspector === 'comments',
    onOpenChange: setCommentsOpen,
    threads: threads.annotations,
    documentKind,
    markdownBody,
    threadMarks: threads.threadMarks,
    canvas: threads.railCanvas,
    write: threads.write,
  })

  const nodeInEditor = useNodeInEditor(sync.canvas, sync.onChange, model.scopeKey)

  const { exportError, handleExport } = useSceneExport({
    onExport: sync.exportScene,
    filenameBase: sanitizeExportFilenameBase(model.exportFilenameBase),
    log,
  })

  // The seams themselves are backend-agnostic (see use-document-file-seams.ts);
  // the keeper supplies the binding and the staleness stamps that make an
  // edit made elsewhere show up on the next refresh.
  const fileSeams = useDocumentFileSeams({
    canvas: sync.canvas,
    adapter: files.adapter,
    resolveAlias: files.resolveAlias,
    resolveTitle: files.resolveTitle,
    stampOf: files.stampOf,
  })

  // Every document the body points at, pre-fetched so the layout's sync
  // seams have content; the list-based alias table and names answer ahead
  // of any load.
  const references = useReferenceSeams({
    body: markdownBody ?? '',
    resolveAlias: files.resolveAlias,
    resolveTitle: files.resolveTitle,
    ...(files.loadReference === undefined ? {} : { load: files.loadReference }),
  })

  const commands = useWhiteboardCommands({
    provider: model.commands.provider,
    canvas: model.commands.canvas,
  })
  // Read once at mount: the routed /settings page is the only place this
  // toggles, and navigating there and back remounts this page (a route
  // change), which re-reads the store fresh — no in-mount reactivity needed.
  const webMcpEnabled = settingsStore.load().capabilities.webMcpEnabled !== false
  useBrowserToolRegistry(commands, model.commands.registryKey, webMcpEnabled)

  // Whole-document operations live behind a kebab: rare + destructive earns
  // a menu (with words) over always-visible icon buttons. The opener belongs
  // in the document's own actions row, not floated over the editor:
  // measured, a control absolutely positioned in the surface's top-right
  // corner sat on top of the markdown editor's catalog trigger and
  // intercepted every click meant for it.
  const rowActions = (
    <>
      <CommentsRailToggle rail={commentsRail} />
      {model.slots.rowAlerts}
      {exportError && (
        <div role="alert" aria-live="assertive" className="text-destructive text-xs">
          {exportError}
        </div>
      )}
      <DocumentMenu
        onExport={(format) => void handleExport(format)}
        {...(model.slots.menuTriggerRef === undefined
          ? {}
          : { triggerRef: model.slots.menuTriggerRef })}
      >
        {model.slots.menuItems}
      </DocumentMenu>
      {model.slots.afterMenu}
    </>
  )

  const topBar = model.topBar
  // Fullscreen means the DOCUMENT, maximised: the whole top-bar row —
  // back, title, menus — steps aside with the shell's row above it, which
  // owns the control and floats the way back out. The dock stays because
  // editing is what the extra space is for.
  const { isFullscreen } = useFullscreen()

  return (
    <DocumentPageShell
      srTitle={model.srTitle}
      aside={
        inspector === 'history' && versions.enabled ? (
          <VersionPanel
            workspaceId={versions.workspaceId}
            path={versions.path}
            capabilities={versions.historyCapabilities}
            onRestored={sync.clearLocalUndo}
            onPreview={setPreview}
            refreshSignal={versions.refreshSignal}
            onClose={() => setInspector(null)}
            headerActions={
              <BookmarkAction
                saving={savingVersion}
                outcome={saveVersionOutcome}
                armed={bookmarkArmed}
                onSave={(label) => void saveVersionFromPanel(label)}
              />
            }
          />
        ) : inspector === 'comments' ? (
          /* The annotation layer's document-level surface (ADR-0026
             decision 5) sits BESIDE the editor rather than inside it,
             because one panel serves both document kinds and a markdown
             document has no canvas chrome to host one. Its opener lives in
             the document actions row, in flow.

             Not writable while a past state is on screen: the editor is
             replaced by DocumentPreview but this rail is not, and its
             writes go to the LIVE document. */
          <CommentsRailAside
            rail={commentsRail}
            threads={threads.annotations}
            writable={preview === null && model.readOnlyPast === null}
          />
        ) : inspector === 'connections' &&
          model.connections !== undefined &&
          model.connections.backlinks !== null ? (
          <InspectorPanel kind="connections" onClose={() => setInspector(null)}>
            <ConnectionsPanel
              backlinks={model.connections.backlinks}
              {...(model.connections.mentions === undefined
                ? {}
                : { mentions: model.connections.mentions })}
              // Following a row leaves for the source document, which is
              // the panel's job done — so the slot is released with it.
              onOpen={(entry) => {
                setInspector(null)
                model.connections?.onOpen(entry)
              }}
              {...(model.connections.onLinkify === undefined
                ? {}
                : { onLinkify: model.connections.onLinkify })}
            />
          </InspectorPanel>
        ) : inspector === 'properties' && model.properties.facets !== undefined ? (
          <InspectorPanel kind="properties" onClose={() => setInspector(null)}>
            <DocumentFacetsEditor
              facets={model.properties.facets}
              {...(model.properties.onFacetsChange === undefined
                ? {}
                : { onChange: model.properties.onFacetsChange })}
            />
          </InspectorPanel>
        ) : undefined
      }
      header={
        <>
          {topBar !== null && !isFullscreen && (
            <Suspense
              fallback={
                <div className={cn(TOP_BAR_FALLBACK_HEIGHT, 'shrink-0 border-b bg-background')} />
              }
            >
              <WorkspaceTopBar
                // The merged header row's flexible middle: document identity
                // (title, core facets, display settings) lives in the SAME
                // row as workspace context. The NAME is the workspace's
                // (ADR-0009 decision 2): the keeper either names documents
                // through its own store or takes the identity the bar hands
                // down from `/names` — never a `title` read out of the
                // content, which `storedCoreFacetsSchema` has no room for.
                titleSlot={(identity) => (
                  <>
                    {model.properties.ready ? (
                      <DocumentProperties
                        inline
                        key={documentKey}
                        title={model.title === 'top-bar' ? identity.name : model.title.value}
                        onTitleChange={
                          model.title === 'top-bar' ? identity.onRename : model.title.onChange
                        }
                        // Facets are OKF frontmatter, so only a markdown
                        // document has any (ADR-0009 decision 3); the keeper
                        // answers none for a spatial one.
                        {...(model.properties.facets === undefined
                          ? {}
                          : { facets: model.properties.facets })}
                        propertiesOpen={inspector === 'properties'}
                        onToggleProperties={() => toggleInspector('properties')}
                        // Canvas-level display settings, gated on kind the
                        // same way the facet disclosure is: a markdown
                        // document has no canvas to configure.
                        settings={
                          documentKind === 'spatial' ? (
                            <CanvasDisplaySettings canvas={sync.canvas} onChange={sync.onChange} />
                          ) : undefined
                        }
                        // No save state in the row: the shell mark answers
                        // for the keeper, and only when there is a condition.
                        {...(model.properties.status === undefined
                          ? {}
                          : { status: model.properties.status })}
                        actions={rowActions}
                      />
                    ) : null}
                    {model.connections !== undefined && (
                      <ConnectionsChip
                        backlinks={model.connections.backlinks}
                        open={inspector === 'connections'}
                        onToggle={() => toggleInspector('connections')}
                      />
                    )}
                  </>
                )}
                workspaceId={topBar.workspaceId}
                path={topBar.path}
                {...(topBar.dataMode === undefined ? {} : { dataMode: topBar.dataMode })}
                {...(topBar.onNavigateBack === undefined
                  ? {}
                  : { onNavigateBack: topBar.onNavigateBack })}
                {...(topBar.branchRefreshSignal === undefined
                  ? {}
                  : { branchRefreshSignal: topBar.branchRefreshSignal })}
                {...(topBar.onPreviewVariation === undefined
                  ? {}
                  : { onPreviewVariation: topBar.onPreviewVariation })}
                capabilities={model.capabilities}
                // Whatever the document holds: a keeper writes a history for
                // every kind, and gating this on the editor is what left a
                // markdown document's checkpoints unreachable.
                onToggleHistory={versions.enabled ? () => toggleInspector('history') : undefined}
                historyOpen={inspector === 'history'}
                {...(preview === null ? {} : { preview })}
              />
            </Suspense>
          )}
          {model.slots.headerExtras}
        </>
      }
    >
      {model.slots.replaceEditor ?? (
        <div className="relative h-full min-h-0 min-w-0">
          {preview ? (
            <DocumentPreview past={preview.past} theme={resolvedTheme} />
          ) : model.readOnlyPast ? (
            <DocumentPreview past={model.readOnlyPast} theme={resolvedTheme} />
          ) : (
            <DocumentEditorSurface
              kind={documentKind}
              documentKey={documentKey}
              markdown={
                model.markdown.hydrating
                  ? { body: null, setBody: model.markdown.setBody }
                  : {
                      body: model.markdown.body,
                      setBody: model.markdown.setBody,
                      ...(model.markdown.sourceExtensions === undefined
                        ? {}
                        : { sourceExtensions: model.markdown.sourceExtensions }),
                      ...(model.markdown.autoFocus === undefined
                        ? {}
                        : { autoFocus: model.markdown.autoFocus }),
                      theme: resolvedTheme,
                      meta: model.markdown.meta,
                      ...(model.markdown.title === undefined
                        ? {}
                        : { title: model.markdown.title }),
                      references,
                      linkTargets: files.pickerTargets,
                      onOpenDocument: model.openDocument,
                      threads: threads.annotations,
                      threadMarks: threads.threadMarks,
                      selectedThreadId: commentsRail.selectedThreadId,
                      onSelectThread: commentsRail.revealThread,
                      onComposeThread: commentsRail.composeThread,
                    }
              }
              spatial={() => (
                <SpatialEditorPane
                  className="relative h-full min-h-0"
                  editorKey={documentKey}
                  canvasLoaded={sync.loaded}
                  {...(model.spatial.editorRef === undefined
                    ? {}
                    : { editorRef: model.spatial.editorRef })}
                  {...(model.spatial.agentTouchedNodeIds === undefined
                    ? {}
                    : { agentTouchedNodeIds: model.spatial.agentTouchedNodeIds })}
                  canvas={sync.canvas}
                  onChange={sync.onChange}
                  externalVersion={sync.externalVersion}
                  theme={resolvedTheme}
                  // File-node reference = the target's immutable id; the
                  // same rows the link picker offers (open document
                  // excluded), so the two pickers cannot label one
                  // document two ways.
                  fileRefOptions={fileRefOptions(files.pickerTargets)}
                  onOpenDocument={model.openDocument}
                  missingFileRef={files.missingFileRef}
                  fileSeams={fileSeams}
                  lockedNodeIds={sync.lockedNodeIds}
                  lockedEdgeIds={sync.lockedEdgeIds}
                  onToggleNodeLock={sync.setNodeLock}
                  onToggleEdgeLock={sync.setEdgeLock}
                  nodeInEditor={nodeInEditor}
                  history={{
                    onUndo: () => void sync.undo(),
                    onRedo: () => void sync.redo(),
                    canUndo: sync.canUndo(),
                    canRedo: sync.canRedo(),
                  }}
                  overlayTitle={model.overlayTitle}
                  linkTargets={files.pickerTargets}
                  threads={threads.annotations}
                >
                  {model.spatial.children}
                </SpatialEditorPane>
              )}
            />
          )}
        </div>
      )}
      {model.slots.footer}
    </DocumentPageShell>
  )
}
