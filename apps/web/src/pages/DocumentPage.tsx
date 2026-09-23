import {
  type ComponentProps,
  lazy,
  type ReactNode,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { DocumentEditorSurface } from '../components/document-editor/DocumentEditorSurface.js'
import { DocumentPageShell } from '../components/document-editor/DocumentPageShell.js'
import { SpatialEditorPane } from '../components/document-editor/SpatialEditorPane.js'
import { useNodeInEditor } from '../components/document-editor/use-node-in-editor.js'
import { DocumentProperties } from '../components/document-properties/DocumentProperties.js'
import { VersionPreview } from '../components/VersionPreview.js'
import type { VersionPreviewSession } from '../components/VersionTimeline'
import { sanitizeExportFilenameBase } from '../components/workspace-top-bar/export-filename.js'
import { useBookmarkShortcut } from '../components/workspace-top-bar/useBookmarkShortcut.js'
import { useSceneExport } from '../components/workspace-top-bar/useSceneExport.js'
import { useCommentsRail } from '../hooks/use-comments-rail.js'
import { useDocumentFileSeams } from '../hooks/use-document-file-seams.js'
import { useFullscreen } from '../hooks/use-fullscreen.js'
import { useReferenceSeams } from '../hooks/use-reference-seams.js'
import { useThemeMode } from '../hooks/useThemeMode.js'
import { getAppLogger } from '../lib/app-logger.js'
import { useWhiteboardCommands } from '../lib/commands/index.js'
import { fileRefOptions } from '../lib/link-entries.js'
import { applyCommand } from '../lib/spatial/commands.js'
import type { SpatialEditorHandle } from '../lib/spatial/editor-handle.js'
import type { ResolvedTheme } from '../lib/theme.js'
import { createUserSettingsStore } from '../lib/user-settings-store.js'
import { cn } from '../lib/utils.js'
import { useBrowserToolRegistry } from '../lib/webmcp/use-browser-tool-registry.js'
import type { DocumentKeeper, DocumentKeeperEvents } from './document-keeper.js'
import {
  DocumentInspectorSegment,
  DocumentRowActions,
  inspectorPanelsFor,
  useInspectorSlot,
} from './document-page-inspector.js'
import type { DocumentPageModel } from './document-page-model.js'
import { useVersionSaveFlow } from './use-version-save-flow.js'

// WorkspaceTopBar statically imports Radix, lucide and VersionTimeline. None
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
 * `App` hands it a keeper and that keeper's props; the keeper's hook runs
 * the controller, the sync backend, the body and the versions, and answers
 * either a model or a terminal screen of its own. Everything this component
 * owns names no keeper: the history column's refresh signal here, and in the
 * body below, which inspector is open beside the editor (properties,
 * comments, connections or history), which past state is being looked at, the
 * save-a-version flow, the seams the editor reads.
 *
 * Two components rather than one so the body's hooks run only while there is
 * a model to run them on — a keeper answering `terminal` renders its screen
 * and mounts nothing of the page, exactly as the keeper pages did before the
 * page was shared.
 */
export function DocumentPage<Props>({
  keeper,
  props,
}: {
  keeper: DocumentKeeper<Props>
  props: Props
}) {
  // Bumped on any version created — this page's own save, a peer's, an
  // agent's — so an open history column re-reads without waiting for its
  // poll. Owned here rather than by the keeper because the column is the
  // page's; the keeper only says WHEN.
  const [versionRefreshSignal, setVersionRefreshSignal] = useState(0)
  const events = useMemo<DocumentKeeperEvents>(
    () => ({ onVersionCreated: () => setVersionRefreshSignal((n) => n + 1) }),
    [],
  )
  const answer = keeper.useDocument(props, events)
  if (answer.kind === 'terminal') return answer.node
  const page: ReactNode = (
    <DocumentPageBody model={answer.model} versionRefreshSignal={versionRefreshSignal} />
  )
  return answer.wrap === undefined ? page : answer.wrap(page)
}

/**
 * Renders the shell, the history column, the merged header row, the editor
 * surface and the comments rail from a `DocumentPageModel`. Nothing in here
 * asks which keeper built the model.
 */
/**
 * The page's own hold on the spatial editor, so an inspector row can reach
 * back into the board (ADR-0029 decision 1: the panel is an index, and a row
 * press takes you to where the change is already drawn).
 *
 * Merged with whatever ref the keeper supplied rather than replacing it: the
 * daemon page holds one for MCP viewport requests, and both want the same
 * handle.
 */
function useMergedSpatialHandle(keeperEditorRef: DocumentPageModel['spatial']['editorRef']) {
  const spatialHandle = useRef<SpatialEditorHandle | null>(null)
  const attachSpatialHandle = useCallback(
    (node: SpatialEditorHandle | null) => {
      spatialHandle.current = node
      if (typeof keeperEditorRef === 'function') keeperEditorRef(node)
      else if (keeperEditorRef !== null && keeperEditorRef !== undefined) {
        keeperEditorRef.current = node
      }
    },
    [keeperEditorRef],
  )
  return { spatialHandle, attachSpatialHandle }
}

/**
 * The merged header row, or nothing while the document is maximised:
 * fullscreen means the DOCUMENT, so the whole row — back, title, menus —
 * steps aside with the shell's row above it.
 */
function DocumentHeader({
  topBar,
  isFullscreen,
  model,
  rowActions,
  documentKey,
  preview,
}: {
  topBar: NonNullable<DocumentPageModel['topBar']> | null
  isFullscreen: boolean
  model: DocumentPageModel
  rowActions: ReactNode
  documentKey: string
  preview: VersionPreviewSession | null
}) {
  return (
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
                    // No save state in the row: the shell mark answers
                    // for the keeper, and only when there is a condition.
                    {...(model.properties.status === undefined
                      ? {}
                      : { status: model.properties.status })}
                    actions={rowActions}
                  />
                ) : null}
              </>
            )}
            workspaceId={topBar.workspaceId}
            path={topBar.path}
            {...(topBar.dataMode === undefined ? {} : { dataMode: topBar.dataMode })}
            {...(topBar.onNavigateBack === undefined
              ? {}
              : { onNavigateBack: topBar.onNavigateBack })}
            {...(preview === null ? {} : { preview })}
          />
        </Suspense>
      )}
      {model.slots.headerExtras}
    </>
  )
}

/**
 * The History column's own save door. The top bar's dot and ⌘/Ctrl+S are the
 * other two routes; on a phone the shortcut is nothing and the dot is small,
 * so the column a finger opens has to carry one too.
 *
 * Both halves refuse a keeper with no history, and the outer one is what
 * makes the inner unreachable — it never calls `run`, so the throw below is
 * the narrowing rather than a case a caller can reach.
 */
function useVersionSavePanel(
  currentScopeRef: RefObject<DocumentPageModel['scopeKey'] | null>,
  scopeKey: DocumentPageModel['scopeKey'],
  versions: DocumentPageModel['versions'],
) {
  const {
    saving: savingVersion,
    outcome: saveVersionOutcome,
    run: runVersionSave,
  } = useVersionSaveFlow(currentScopeRef, scopeKey, async (label) => {
    if (!versions.enabled) {
      throw new Error('saveVersionFromPanel: this keeper has no history for the document')
    }
    await versions.save(label)
    // Returned rather than fired here: `useVersionSaveFlow` runs it only
    // once it has confirmed the saved document is still the one on screen,
    // so a save that lands after the reader moved on refreshes nothing.
    return () => {
      versions.announceRefresh()
      versions.announceOnce?.()
    }
  })
  const saveVersionFromPanel = async (label: string): Promise<void> => {
    if (!versions.enabled) return
    await runVersionSave(label)
  }
  return { savingVersion, saveVersionOutcome, saveVersionFromPanel }
}

/**
 * What the markdown pane is handed. A builder rather than inline JSX because
 * the optional fields are spread-or-nothing (the props are `exactOptionalPropertyTypes`,
 * so `undefined` is not the same as absent), and a column of those inside a
 * render reads as branching the page does not do.
 *
 * `hydrating` is the one real branch: a body that has not arrived is `null`
 * rather than an empty document, so the editor draws a waiting pane instead
 * of one a keystroke would commit over.
 */
function markdownPaneProps({
  model,
  resolvedTheme,
  references,
  files,
  threads,
  commentsRail,
  sync,
  decidePassage,
}: {
  model: DocumentPageModel
  resolvedTheme: ResolvedTheme
  references: ReturnType<typeof useReferenceSeams>
  files: DocumentPageModel['files']
  threads: DocumentPageModel['threads']
  commentsRail: ReturnType<typeof useCommentsRail>
  sync: DocumentPageModel['sync']
  decidePassage: (proposalId: string, changeId: string, decision: 'adopted' | 'dismissed') => void
}): ComponentProps<typeof DocumentEditorSurface>['markdown'] {
  const { markdown } = model
  if (markdown.hydrating) return { body: null, setBody: markdown.setBody }
  return {
    body: markdown.body,
    setBody: markdown.setBody,
    ...(markdown.sourceExtensions === undefined
      ? {}
      : { sourceExtensions: markdown.sourceExtensions }),
    ...(markdown.autoFocus === undefined ? {} : { autoFocus: markdown.autoFocus }),
    theme: resolvedTheme,
    meta: markdown.meta,
    ...(markdown.title === undefined ? {} : { title: markdown.title }),
    references,
    linkTargets: files.pickerTargets,
    onOpenDocument: model.openDocument,
    threads: threads.annotations,
    threadMarks: threads.threadMarks,
    selectedThreadId: commentsRail.selectedThreadId,
    onSelectThread: commentsRail.revealThread,
    onComposeThread: commentsRail.composeThread,
    proposals: sync.proposals,
    onDecidePassage: decidePassage,
  }
}

function DocumentPageBody({
  model,
  versionRefreshSignal,
}: {
  model: DocumentPageModel
  versionRefreshSignal: number
}) {
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
  const { inspector, setInspector, toggleInspector, setCommentsOpen } = useInspectorSlot()

  /**
   * The page's own hold on the spatial editor, so an inspector row can reach
   * back into the board (ADR-0029 decision 1: the panel is an index, and a
   * row press takes you to where the change is already drawn — it does not
   * open a second place to decide).
   *
   * Merged with whatever ref the keeper supplied rather than replacing it:
   * the daemon page holds one for MCP viewport requests, and both want the
   * same handle.
   */
  const { spatialHandle, attachSpatialHandle } = useMergedSpatialHandle(model.spatial.editorRef)

  // Bumped by whoever asks for a bookmark (see requestBookmark below), which
  // opens the column with its naming field ready. Nothing here takes one.
  const [bookmarkArmed, setBookmarkArmed] = useState(0)
  // The past state the person is LOOKING at, drawn in place of the editor.
  // Read-only by construction — see VersionPreview — so "look, then decide"
  // cannot turn into an edit against a state that is not the document's.
  const [preview, setPreview] = useState<VersionPreviewSession | null>(null)
  // Asking for a bookmark opens the History column with its naming field
  // ready — the naming is the whole value, and a row named nothing is
  // indistinguishable from the automatic checkpoint above it, so it happens
  // beside the list rather than in the chrome. Two routes reach it: the
  // ⌘/Ctrl+S chord, which no longer saves anything by itself, and the
  // document's ⋯ menu, which is what a finger has.
  const requestBookmark = useCallback(() => {
    setInspector('history')
    setBookmarkArmed((n) => n + 1)
  }, [])
  useBookmarkShortcut(versions.enabled, requestBookmark)

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

  const { savingVersion, saveVersionOutcome, saveVersionFromPanel } = useVersionSavePanel(
    currentScopeRef,
    model.scopeKey,
    versions,
  )

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

  /**
   * A passage decided from the body (ADR-0029 decision 6). The same command
   * the canvas card issues, so the two surfaces cannot mean different things
   * by "adopt" — the write path in `document-sync-session` is what knows a
   * body.replace has to rewrite the body, and it is reached from here for
   * the same reason it is reached from there.
   *
   * The command carries the CHANGE, read from the proposal it names rather
   * than rebuilt: what gets applied is exactly what the card showed.
   */
  const decidePassage = useCallback(
    (proposalId: string, changeId: string, decision: 'adopted' | 'dismissed') => {
      const change = sync.proposals
        .find((one) => one.id === proposalId)
        ?.changes.find((one) => one.id === changeId)
      if (change === undefined) return
      const command = {
        kind: 'decide-proposal',
        proposalId,
        decision,
        changes: [change],
      } as const
      sync.onChange(applyCommand(sync.canvas, command), command)
    },
    [sync.canvas, sync.onChange, sync.proposals],
  )

  const nodeInEditor = useNodeInEditor(sync.canvas, sync.onChange, model.scopeKey)

  const { exportError, handleExport } = useSceneExport({
    // The saved picture draws by the library too, so what a person exports
    // from the editor is what the daemon's export and the screen show.
    onExport: (format) =>
      sync.exportScene(format, model.tags === undefined ? {} : { tagLibrary: model.tags.library }),
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
    bodies: nodeInEditor.draftBodies,
  })

  // Every document the body points at, pre-fetched so the layout's sync
  // seams have content; the list-based alias table and names answer ahead
  // of any load.
  const references = useReferenceSeams({
    body: markdownBody ?? '',
    resolveAlias: files.resolveAlias,
    resolveTitle: files.resolveTitle,
    ...(files.loadReference === undefined ? {} : { load: files.loadReference }),
    // The same adapter the board resolves its pictures through, so a body's
    // inline attachment previews here instead of drawing the written path.
    loadImage: (ref) => files.adapter.loadImageUrl(ref),
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
  // The four ways to look at this document, as ONE control — see
  // `InspectorSegment`. What a KIND decides is which members it offers;
  // never their order, which is why a canvas and a note read the same now.
  const inspectorSegment = (
    <DocumentInspectorSegment
      inspector={inspector}
      toggleInspector={toggleInspector}
      model={model}
      documentKind={documentKind}
      openThreadCount={commentsRail.openThreadCount}
      proposals={threads.proposals}
      versionsEnabled={versions.enabled}
    />
  )

  const rowActions = (
    <DocumentRowActions
      inspectorSegment={inspectorSegment}
      model={model}
      exportError={exportError}
      onExport={handleExport}
      onBookmark={requestBookmark}
      versionsEnabled={versions.enabled}
    />
  )

  const topBar = model.topBar
  // No variation chrome here, and no `?v=`: ADR-0029 retires the surface.
  // A proposal is drawn on the document a person is already looking at, so
  // a lane to switch onto — and an address that names which one — is the
  // shape that decision rejects. What used to stand here was the chip, the
  // preview hook that owned `?v=`, and the read-only tip it rendered.
  //
  // The read-only slot itself SURVIVES: a past version still renders there
  // (History is unchanged by ADR-0029), and `preview` below is that one.
  // Fullscreen means the DOCUMENT, maximised: the whole top-bar row —
  // back, title, menus — steps aside with the shell's row above it, which
  // owns the control and floats the way back out. The dock stays because
  // editing is what the extra space is for.
  const { isFullscreen } = useFullscreen()

  /**
   * The slot's switchboard, keyed by the union rather than by a chain of
   * `inspector === K &&` ternaries.
   *
   * Same shape `INSPECTOR_ORDER` and `INSPECTOR_LABELS` already use, one step
   * further: the union drove the header's order and its labels, and the
   * RENDER was the last place a panel was still named by hand — so a seventh
   * `InspectorKind` compiled, took a place in the header, and showed nothing
   * when pressed. It no longer compiles.
   *
   * A thunk rather than a node, so only the selected panel's JSX is built —
   * and so each arm keeps closing over exactly what it reads today instead of
   * being threaded through a component with fourteen props.
   *
   * `undefined` from an arm means "selected, but this document has nothing to
   * show there", which is what the guards in the chain meant: the slot then
   * stays empty rather than falling through to another panel.
   */
  const inspectorPanels = inspectorPanelsFor({
    versions,
    sync,
    setPreview,
    versionRefreshSignal,
    setInspector,
    savingVersion,
    saveVersionOutcome,
    bookmarkArmed,
    saveVersionFromPanel,
    commentsRail,
    threads,
    preview,
    documentKind,
    model,
    spatialHandle,
  })

  return (
    <DocumentPageShell
      srTitle={model.srTitle}
      aside={inspector === null ? undefined : inspectorPanels[inspector]()}
      header={
        <DocumentHeader
          topBar={topBar}
          isFullscreen={isFullscreen}
          model={model}
          rowActions={rowActions}
          documentKey={documentKey}
          preview={preview}
        />
      }
    >
      {model.slots.replaceEditor ?? (
        <div className="relative h-full min-h-0 min-w-0">
          {preview ? (
            <VersionPreview past={preview.past} theme={resolvedTheme} />
          ) : (
            <DocumentEditorSurface
              kind={documentKind}
              documentKey={documentKey}
              markdown={markdownPaneProps({
                model,
                resolvedTheme,
                references,
                files,
                threads,
                commentsRail,
                sync,
                decidePassage,
              })}
              spatial={() => (
                <SpatialEditorPane
                  className="relative h-full min-h-0"
                  editorKey={documentKey}
                  canvasLoaded={sync.loaded}
                  editorRef={attachSpatialHandle}
                  {...(model.spatial.agentTouchedNodeIds === undefined
                    ? {}
                    : { agentTouchedNodeIds: model.spatial.agentTouchedNodeIds })}
                  canvas={sync.canvas}
                  onChange={sync.onChange}
                  externalVersion={sync.externalVersion}
                  theme={resolvedTheme}
                  {...(model.tags === undefined
                    ? {}
                    : { tagSuggestions: model.tags.inUse, tagLibrary: model.tags.library })}
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
                  proposals={threads.proposals}
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
