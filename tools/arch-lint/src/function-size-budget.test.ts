import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'

// docs/contributing/review-checklist.md says "functions stay under 50
// lines". `file-size-budget.test.ts` made its companion clause — "files stay
// under 800 lines" — executable and said in its own header why it stopped
// there: finding a function's boundaries needs an AST, which is a different
// instrument than counting a file's newlines. This is that instrument.
//
// It is the SAME contract: a shrink-only grandfather list, guarded from both
// sides, so an entry cannot outlive the debt it names. An over-budget
// function not in the list fails naming it and its count; a listed function
// that has shrunk to 50 or under fails telling the closer to delete the
// entry. An entry is a CEILING, not a reading, so shrinking a listed
// function from 400 lines to 200 needs no edit here — only crossing the
// budget, or growing past the recorded number, does.
//
// **Why a per-file budget could not catch this class, measured.** #1717
// moved 834 lines of pointer handling out of `SpatialEditor.tsx` into
// `use-editor-pointer.ts`. Both files ended under 800, `file-size-budget`
// stayed green, and the diff read as a decomposition — but the 834 lines are
// still ONE function (`useEditorPointer`, fourth-largest in the repo).
// Relocating mass satisfies a file budget while the function survives whole.
//
// **Why it lives in `tools/arch-lint` rather than beside its sibling.** The
// AST comes from `@typescript/typescript6`, which only this package depends
// on, and `architecture-map.md` puts cross-package source scans here — every
// guard in this project reads OTHER packages' source, which is why the whole
// project runs at pre-push. `file-size-budget.test.ts` is still named a
// pre-push command of its own; this one needs no new line.
//
// **Why the list is 400-odd entries and not 17.** That is what the rule's drift
// actually costs — measured, not chosen. At a budget of 100 it would be 161
// entries, at 150 it would be 86; picking one of those would be picking the
// number that makes the debt look smaller, over the number the checklist
// states. The list is data rather than prose for the same reason.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')

const LINE_BUDGET = 50

/** The `src` directory of every package/tool matching a `<group>/*` glob that has one. */
function groupSrcDirs(group: string): string[] {
  return readdirSync(join(REPO_ROOT, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(group, entry.name, 'src'))
    .filter((relDir) => existsSync(join(REPO_ROOT, relDir)))
}

const SCAN_ROOTS = ['apps/web/src', ...groupSrcDirs('packages'), ...groupSrcDirs('tools')]

/** The same two exclusions `file-size-budget.test.ts` makes, for the same reasons. */
const EXCLUDED_DIR_SEGMENTS = ['/migrations/', '/vendor/budoux/']

function walk(absoluteDir: string): string[] {
  return readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(absoluteDir, entry.name)
    return entry.isDirectory() ? walk(absolutePath) : [absolutePath]
  })
}

interface Measured {
  /** `<repo-relative path>#<qualified name>` — unique, and stable under a move of lines. */
  readonly key: string
  readonly lines: number
  readonly isTest: boolean
}

/**
 * Every NAMED function in a file, with the chain of named functions enclosing
 * it.
 *
 * Qualified because a bare `path#name` collides — measured across the repo,
 * qualifying takes the colliding keys to zero. An anonymous callback is not
 * measured: it has no name to put in a ledger, and its lines already count
 * toward the named function that holds it, which is the one a reader would
 * shrink.
 */
function measureFile(absolutePath: string, relativePath: string): Measured[] {
  const isTest = /\.(test|spec)\.tsx?$/.test(relativePath)
  const source = ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const found: Measured[] = []
  const visit = (node: ts.Node, chain: readonly string[]): void => {
    let name: string | undefined
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) name = node.name?.getText()
    else if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      ts.isVariableDeclaration(node.parent)
    )
      name = node.parent.name.getText()
    let inner = chain
    if (name !== undefined && (node as ts.FunctionLikeDeclaration).body !== undefined) {
      const qualified = [...chain, name].join('.')
      const from = source.getLineAndCharacterOfPosition(node.getStart(source)).line
      const to = source.getLineAndCharacterOfPosition(node.getEnd()).line
      found.push({ key: `${relativePath}#${qualified}`, lines: to - from + 1, isTest })
      inner = [...chain, name]
    }
    ts.forEachChild(node, (child) => {
      visit(child, inner)
    })
  }
  ts.forEachChild(source, (child) => {
    visit(child, [])
  })
  // A qualified name can still repeat inside one file — a model-based
  // property test gives every command its own `check`/`run`/`toString`, and
  // 111 keys across the repo collide that way. The ones that repeat get
  // their occurrence index in source order, so a ledger entry names one
  // function rather than whichever the scan happened to see last: without
  // it, a 120-line `run` and a 20-line `run` shared an entry and the guard
  // read the short one.
  const seen = new Map<string, number>()
  for (const row of found) seen.set(row.key, (seen.get(row.key) ?? 0) + 1)
  const taken = new Map<string, number>()
  return found.map((row) => {
    if ((seen.get(row.key) ?? 0) < 2) return row
    const index = (taken.get(row.key) ?? 0) + 1
    taken.set(row.key, index)
    return { ...row, key: `${row.key}~${String(index)}` }
  })
}

const MEASURED: readonly Measured[] = SCAN_ROOTS.flatMap((relDir) =>
  walk(join(REPO_ROOT, relDir))
    .filter(
      (absolutePath) =>
        /\.tsx?$/.test(absolutePath) &&
        !absolutePath.endsWith('.d.ts') &&
        !EXCLUDED_DIR_SEGMENTS.some((segment) => absolutePath.includes(segment)),
    )
    .flatMap((absolutePath) =>
      measureFile(absolutePath, absolutePath.slice(REPO_ROOT.length + 1).replaceAll('\\', '/')),
    ),
)

const BY_KEY = new Map(MEASURED.map((row) => [row.key, row.lines]))

/**
 * Source functions over the budget when this guard landed, each with the
 * ceiling it had then. Shrink-only: see the header.
 */
const FUNCTION_SIZE_GRANDFATHER: Record<string, number> = {
  'apps/web/src/App.tsx#App': 763,
  'apps/web/src/components/AppShell.tsx#AppShell': 299,
  'apps/web/src/components/DocumentPreview.tsx#PastCanvasPreview': 67,
  'apps/web/src/components/EditorExitHint.tsx#EditorExitHint': 109,
  'apps/web/src/components/FontsCard.tsx#FontsCard': 129,
  'apps/web/src/components/PairedOriginsCard.tsx#PairedOriginsCard': 141,
  'apps/web/src/components/PasskeysCard.tsx#PasskeysCard': 184,
  'apps/web/src/components/StorageReportCard.tsx#StorageReportCard': 441,
  'apps/web/src/components/VersionTimeline.tsx#VersionTimeline': 332,
  'apps/web/src/components/WorkspaceTopBar.tsx#WorkspaceTopBar': 102,
  'apps/web/src/components/annotations/CommentBody.tsx#CommentBody': 64,
  'apps/web/src/components/annotations/CommentComposer.tsx#CommentComposer': 69,
  'apps/web/src/components/annotations/CommentsPanel.tsx#CommentsPanel': 578,
  'apps/web/src/components/annotations/ReplyComposer.tsx#ReplyComposer': 54,
  'apps/web/src/components/connection/ConnectionStatus.tsx#ConnectionStatus': 165,
  'apps/web/src/components/document-editor/DocumentPageShell.tsx#DocumentPageShell': 92,
  'apps/web/src/components/document-editor/InspectorPanel.tsx#InspectorPanel': 139,
  'apps/web/src/components/document-editor/InspectorSegment.tsx#InspectorSegment': 56,
  'apps/web/src/components/document-editor/NodeTextEditorOverlay.tsx#NodeTextEditorOverlay': 103,
  'apps/web/src/components/document-editor/SpatialEditorPane.tsx#SpatialEditorPane': 86,
  'apps/web/src/components/document-editor/use-node-in-editor.tsx#useNodeInEditor': 56,
  'apps/web/src/components/document-properties/DocumentProperties.tsx#DocumentFacetsEditor': 117,
  'apps/web/src/components/document-properties/DocumentProperties.tsx#DocumentProperties': 110,
  'apps/web/src/components/markdown-editor/EditorToolbar.tsx#EditorToolbar': 135,
  'apps/web/src/components/markdown-editor/LinkPickerDialog.tsx#LinkPickerDialog': 160,
  'apps/web/src/components/markdown-editor/MarkdownEditor.tsx#MarkdownEditor': 786,
  'apps/web/src/components/markdown-editor/MarkdownVerbBar.tsx#MarkdownVerbBar': 88,
  'apps/web/src/components/markdown-editor/MinimapRail.tsx#MinimapRail': 80,
  'apps/web/src/components/markdown-editor/PassageProposalCard.tsx#PassageProposalCard': 63,
  'apps/web/src/components/markdown-editor/PreviewPane.tsx#PreviewPane': 52,
  'apps/web/src/components/markdown-editor/SourcePane.tsx#SourcePane': 295,
  'apps/web/src/components/markdown-editor/TouchFormattingBarPanel.tsx#TouchFormattingBarPanel': 128,
  'apps/web/src/components/markdown-editor/annotation-decorations.ts#annotationDecorations': 74,
  'apps/web/src/components/markdown-editor/editor-verbs.ts#wrapSelectionWith': 63,
  'apps/web/src/components/markdown-editor/proposal-decorations.ts#proposalDecorations': 71,
  'apps/web/src/components/markdown-editor/verb-catalog.tsx#verbCatalogItems': 64,
  'apps/web/src/components/migration/DaemonDetectedBanner.tsx#DaemonDetectedBanner': 649,
  'apps/web/src/components/migration/DaemonDetectedBanner.tsx#DaemonDetectedBanner.runProbe': 92,
  'apps/web/src/components/settings/MembersCard.tsx#MembersCard': 334,
  'apps/web/src/components/settings/PromoteWorkspaceSection.tsx#PromoteWorkspaceSection': 522,
  'apps/web/src/components/settings/SetupJourney.tsx#SetupJourney': 163,
  'apps/web/src/components/shell/ShellMark.tsx#ShellMark': 123,
  'apps/web/src/components/shell/WorkspaceMenu.tsx#WorkspaceMenu': 339,
  'apps/web/src/components/spatial-editor/BoxTargetOverlay.tsx#BoxTargetOverlay': 95,
  'apps/web/src/components/spatial-editor/CanvasContextMenu.tsx#CanvasContextMenu': 208,
  'apps/web/src/components/spatial-editor/CanvasDisplaySettings.tsx#CanvasDisplaySettings': 97,
  'apps/web/src/components/spatial-editor/CommentThreadCard.tsx#CommentThreadCard': 191,
  'apps/web/src/components/spatial-editor/ContextMenu.tsx#ContextMenu': 246,
  'apps/web/src/components/spatial-editor/ContextMenu.tsx#ContextMenu.renderCatalogItem': 102,
  'apps/web/src/components/spatial-editor/DocumentPickerDialog.tsx#DocumentPickerDialog': 62,
  'apps/web/src/components/spatial-editor/DragPreviewLayer.tsx#DragPreviewLayer': 80,
  'apps/web/src/components/spatial-editor/EdgeBendHandles.tsx#EdgeBendHandles': 102,
  'apps/web/src/components/spatial-editor/EdgeEndHandles.tsx#EdgeEndHandles': 68,
  'apps/web/src/components/spatial-editor/EdgeSelectionHighlight.tsx#EdgeSelectionHighlight': 52,
  'apps/web/src/components/spatial-editor/LegendOverlay.tsx#LegendOverlay': 73,
  'apps/web/src/components/spatial-editor/LinkEmbedLayer.tsx#LinkEmbedLayer': 98,
  'apps/web/src/components/spatial-editor/LinkUrlDialog.tsx#LinkUrlDialog': 83,
  'apps/web/src/components/spatial-editor/MarkdownNodeEditor.tsx#MarkdownNodeEditor': 271,
  'apps/web/src/components/spatial-editor/MemberOutlinesOverlay.tsx#MemberOutlinesOverlay': 61,
  'apps/web/src/components/spatial-editor/MinimapOverlay.tsx#MinimapOverlay': 108,
  'apps/web/src/components/spatial-editor/ProposalCard.tsx#ProposalCard': 160,
  'apps/web/src/components/spatial-editor/SelectionOverlay.tsx#SelectionOverlay': 319,
  'apps/web/src/components/spatial-editor/SnapGuidesOverlay.tsx#SnapGuidesOverlay': 76,
  'apps/web/src/components/spatial-editor/SpatialEditor.tsx#applyResult': 68,
  'apps/web/src/components/spatial-editor/SpatialEditor.tsx#runNavigation': 55,
  'apps/web/src/components/spatial-editor/TextNodeEditor.tsx#TextNodeEditor': 91,
  'apps/web/src/components/spatial-editor/ToolPalette.tsx#ToolPalette': 259,
  'apps/web/src/components/spatial-editor/comment-compose-overlay.tsx#CommentComposeOverlay': 96,
  'apps/web/src/components/spatial-editor/context-menu-items/canvas-menu-items.tsx#canvasMenuItems': 91,
  'apps/web/src/components/spatial-editor/context-menu-items/color-row.tsx#colorRow': 55,
  'apps/web/src/components/spatial-editor/context-menu-items/edge-menu-items.tsx#edgeMenuItems': 93,
  'apps/web/src/components/spatial-editor/context-menu-items/ink-menu-items.tsx#inkMenuItems': 166,
  'apps/web/src/components/spatial-editor/context-menu-items/node-menu-items.tsx#nodeMenuItems': 385,
  'apps/web/src/components/spatial-editor/drag-preview.ts#computeDragPreview': 102,
  'apps/web/src/components/spatial-editor/facet-widgets/FacetFormPanel.tsx#FacetFormPanel': 132,
  'apps/web/src/components/spatial-editor/gesture-snap.ts#snapGesturePoint': 74,
  'apps/web/src/components/spatial-editor/gesture-trace.ts#createGestureTrace': 83,
  'apps/web/src/components/spatial-editor/gestures.ts#reduceGesture': 238,
  'apps/web/src/components/spatial-editor/gestures.ts#reducePointerUpResizing': 52,
  'apps/web/src/components/spatial-editor/label-editor-overlays.tsx#EdgeLabelEditorOverlay': 59,
  'apps/web/src/components/spatial-editor/markdown-body-editor-overlay.tsx#MarkdownBodyEditorOverlay': 109,
  'apps/web/src/components/spatial-editor/navigation.ts#reducePointerDown': 133,
  'apps/web/src/components/spatial-editor/navigation.ts#reducePointerMove': 58,
  'apps/web/src/components/spatial-editor/navigation.ts#reducePointerUp': 76,
  'apps/web/src/components/spatial-editor/pointer-release.ts#commitRelease': 125,
  'apps/web/src/components/spatial-editor/pointer-release.ts#releaseMarquee': 78,
  'apps/web/src/components/spatial-editor/use-canvas-replacement.ts#useCanvasReplacement': 86,
  'apps/web/src/components/spatial-editor/use-clipboard-actions.ts#useClipboardActions': 237,
  'apps/web/src/components/spatial-editor/use-clipboard-actions.ts#useClipboardActions.pasteFragment': 96,
  'apps/web/src/components/spatial-editor/use-comment-state.ts#useCommentState': 124,
  'apps/web/src/components/spatial-editor/use-drag-layers.ts#useDragLayers': 363,
  'apps/web/src/components/spatial-editor/use-edit-session-state.ts#useEditSessionState': 125,
  'apps/web/src/components/spatial-editor/use-editor-keyboard.ts#useEditorKeyboard': 352,
  'apps/web/src/components/spatial-editor/use-editor-keyboard.ts#useEditorKeyboard.handleKeyDown': 157,
  'apps/web/src/components/spatial-editor/use-editor-keyboard.ts#useEditorKeyboard.handleResizeHandleKeyDown': 74,
  'apps/web/src/components/spatial-editor/use-editor-pointer.ts#useEditorPointer': 835,
  'apps/web/src/components/spatial-editor/use-editor-pointer.ts#useEditorPointer.handlePointerDown': 249,
  'apps/web/src/components/spatial-editor/use-editor-pointer.ts#useEditorPointer.handlePointerUp': 120,
  'apps/web/src/components/spatial-editor/use-editor-pointer.ts#useEditorPointer.openContextMenuAt': 79,
  'apps/web/src/components/spatial-editor/use-file-seam-scene.ts#useFileSeamScene': 93,
  'apps/web/src/components/spatial-editor/use-interaction-state.ts#useInteractionState': 139,
  'apps/web/src/components/spatial-editor/use-keyboard-avoidance.ts#useKeyboardAvoidance': 103,
  'apps/web/src/components/spatial-editor/use-lock-policy.ts#useLockPolicy': 72,
  'apps/web/src/components/spatial-editor/use-native-canvas-listeners.ts#useNativeCanvasListeners': 127,
  'apps/web/src/components/spatial-editor/use-node-creation.ts#useNodeCreation': 147,
  'apps/web/src/components/spatial-editor/use-scene-projection.ts#useSceneProjection': 159,
  'apps/web/src/components/spatial-editor/use-worker-scene.ts#useWorkerScene': 217,
  'apps/web/src/components/tags/TagChipsEditor.tsx#TagChipsEditor': 96,
  'apps/web/src/components/use-preview-viewport.ts#usePreviewViewport': 97,
  'apps/web/src/components/workspace-files/DocumentMinimap.tsx#DocumentMinimap': 85,
  'apps/web/src/components/workspace-files/DocumentPathField.tsx#DocumentPathField': 72,
  'apps/web/src/components/workspace-files/DocumentPreview.tsx#DocumentPreview': 167,
  'apps/web/src/components/workspace-files/DocumentThumbnail.tsx#DocumentThumbnail': 83,
  'apps/web/src/components/workspace-files/EmptyWorkspaceState.tsx#EmptyWorkspaceState': 146,
  'apps/web/src/components/workspace-files/FolderContentsList.tsx#FolderContentsList': 205,
  'apps/web/src/components/workspace-files/NewDocumentDialog.tsx#NewDocumentDialog': 165,
  'apps/web/src/components/workspace-files/NewDocumentMenu.tsx#NewDocumentMenu': 139,
  'apps/web/src/components/workspace-files/RecentLane.tsx#RecentLane': 53,
  'apps/web/src/components/workspace-files/RenameDocumentDialog.tsx#RenameDocumentDialog': 103,
  'apps/web/src/components/workspace-files/SearchResults.tsx#SearchResults': 262,
  'apps/web/src/components/workspace-files/TrashSection.tsx#TrashSection': 82,
  'apps/web/src/components/workspace-files/WorkspaceFileTree.tsx#DocumentRow': 57,
  'apps/web/src/components/workspace-files/WorkspaceFileTree.tsx#TreeItem': 80,
  'apps/web/src/components/workspace-files/WorkspaceFilesPanel.tsx#WorkspaceFilesPanel': 992,
  'apps/web/src/components/workspace-files/WorkspaceFilesPanel.tsx#WorkspaceFilesPanel.renderColumns': 167,
  'apps/web/src/components/workspace-files/WorkspaceFolderTree.tsx#FolderItem': 68,
  'apps/web/src/components/workspace-files/use-debounced-document-search.ts#useDebouncedDocumentSearch': 60,
  'apps/web/src/components/workspace-files/use-device-memory.ts#useDeviceMemory': 62,
  'apps/web/src/components/workspace-files/use-long-press.ts#useLongPressMenu': 65,
  'apps/web/src/components/workspace-files/use-rename-document.ts#useRenameDocument': 63,
  'apps/web/src/components/workspace-top-bar/BookmarkAction.tsx#BookmarkAction': 112,
  'apps/web/src/components/workspace-top-bar/useDocumentNames.ts#useDocumentNames': 55,
  'apps/web/src/hooks/use-comments-rail.ts#useCommentsRail': 187,
  'apps/web/src/hooks/use-document-favicon.ts#useDocumentFavicon': 52,
  'apps/web/src/hooks/use-document-file-seams.ts#useDocumentFileSeams': 131,
  'apps/web/src/hooks/use-image-urls.ts#useImageUrls': 67,
  'apps/web/src/hooks/use-reference-seams.ts#useReferenceSeams': 69,
  'apps/web/src/hooks/use-shell-workspaces.ts#useShellWorkspaces': 107,
  // 196 -> 199 (ADR-0042 S10): the awaitingDaemonRenewal guard — a daemon
  // deep link is undecided, not foreign, while its silent renewal is outstanding.
  'apps/web/src/hooks/use-workspace-address-sync.ts#useWorkspaceAddressSync': 199,
  'apps/web/src/hooks/useDocumentOutline.ts#useDocumentOutline': 68,
  'apps/web/src/hooks/useDocumentSync.ts#useDocumentSync': 365,
  'apps/web/src/lib/browser-backend.ts#loadAndDeliver': 57,
  'apps/web/src/lib/browser-backend.ts#placeMissingDocument': 62,
  'apps/web/src/lib/browser-idb.ts#openWhiteboardDb': 103,
  'apps/web/src/lib/browser-version-store.ts#save': 58,
  'apps/web/src/lib/browser-versions-backend.ts#createBrowserVersionsBackend': 59,
  'apps/web/src/lib/clipboard-fragment.ts#remintClipboardFragment': 55,
  'apps/web/src/lib/daemon-auth-fetch.ts#createDaemonFetch': 54,
  'apps/web/src/lib/daemon-file-adapter.ts#createDaemonFileAdapter': 70,
  'apps/web/src/lib/daemon-files-source.ts#createDaemonFilesSource': 128,
  'apps/web/src/lib/document-sync-session.ts#commandTargetKey': 56,
  'apps/web/src/lib/document-sync-session.ts#createDocumentSyncSession': 842,
  'apps/web/src/lib/document-sync-session.ts#createDocumentSyncSession.connect': 220,
  'apps/web/src/lib/document-sync-session.ts#createDocumentSyncSession.connect.onSnapshot': 101,
  'apps/web/src/lib/document-sync-session.ts#writeCommandTarget': 139,
  'apps/web/src/lib/fold-workspace.ts#foldWorkspaceDocuments': 56,
  'apps/web/src/lib/idb-document-store.ts#loadSnapshot': 60,
  'apps/web/src/lib/keyed-svg-patcher.ts#mountKeyedSvg': 101,
  'apps/web/src/lib/keyed-svg-patcher.ts#mountKeyedSvg.update': 55,
  'apps/web/src/lib/layout-worker-pool.ts#createLayoutWorkerPool': 153,
  'apps/web/src/lib/layout-worker.ts#handleLayout': 67,
  'apps/web/src/lib/local-files-source.ts#createLocalFilesSource': 363,
  'apps/web/src/lib/local-files-source.ts#createLocalFilesSource.listDocuments': 65,
  'apps/web/src/lib/local-files-source.ts#createLocalFilesSource.searchDocuments': 59,
  'apps/web/src/lib/loro-store.ts#appendDelta': 73,
  'apps/web/src/lib/pairing-grant.ts#consumeGrantFragment': 97,
  'apps/web/src/lib/passkey-attestation.ts#registerPasskey': 86,
  'apps/web/src/lib/promote-workspace.ts#promoteWorkspaceUnsafe': 95,
  // 61 -> 64 (ADR-0042 S10): a failed or empty pull now reports itself through
  // reportRefreshFailure/reportNoPull instead of a silent catch.
  'apps/web/src/lib/replica-refresh.ts#scheduleReplicaRefresh': 64,
  'apps/web/src/lib/spatial/commands.ts#applyCommand': 146,
  'apps/web/src/lib/spatial/commands.ts#buildFragmentInsertCommand': 84,
  'apps/web/src/lib/spatial/commands.ts#reorderNodes': 64,
  'apps/web/src/lib/spatial/freehand.ts#freehandLine': 58,
  'apps/web/src/lib/spatial/geometry.ts#findFreeSpot': 64,
  'apps/web/src/lib/spatial/minimap.ts#fitMinimap': 52,
  'apps/web/src/lib/sse-shared-stream-source.ts#createSharedSseStreamSource': 153,
  'apps/web/src/lib/sse-shared-worker.ts#handle': 96,
  'apps/web/src/lib/user-settings-store.ts#createUserSettingsStore': 67,
  'apps/web/src/lib/versions-backend.contract.ts#versionsBackendContract': 95,
  'apps/web/src/pages/BrowserDocumentPage.tsx#useBrowserDocument': 879,
  'apps/web/src/pages/BrowserIndexPage.tsx#BrowserIndexPage': 331,
  'apps/web/src/pages/DaemonDocumentPage.tsx#useDaemonDocument': 697,
  'apps/web/src/pages/DaemonIndexPage.tsx#DaemonIndexPage': 684,
  'apps/web/src/pages/DocumentPage.tsx#DocumentPageBody': 562,
  'apps/web/src/pages/PairConsentPage.tsx#PairConsentPage': 119,
  'apps/web/src/pages/ReplicaReadPage.tsx#ReplicaReadPage': 393,
  'apps/web/src/pages/SettingsPage.tsx#ConnectionsSection': 89,
  'apps/web/src/pages/SettingsPage.tsx#GeneralSection': 112,
  'apps/web/src/pages/SettingsPage.tsx#SettingsPage': 280,
  'apps/web/src/pages/SettingsPage.tsx#sectionContent': 66,
  'apps/web/src/pages/use-auto-checkpoint.ts#useAutoCheckpoint': 60,
  'apps/web/src/pages/use-browser-document-controller.ts#useBrowserDocumentController': 458,
  'apps/web/src/pages/use-browser-document-controller.ts#useBrowserDocumentController.load': 67,
  'apps/web/src/pages/use-daemon-document-controller.ts#useDaemonDocumentController': 157,
  'apps/web/src/pages/use-markdown-document.ts#useMarkdownDocument': 378,
  'apps/web/src/pwa/UpdateToast.tsx#UpdateToast': 57,
  'apps/web/src/pwa/register-sw.ts#setupSwRegistration': 76,
  'apps/web/src/pwa/register-sw.ts#setupSwRegistration.register': 58,
  'apps/web/src/test-utils/document-page.contract.tsx#describeDocumentPageContract': 101,
  'packages/canvas-render/src/layout/comments.ts#composeComments': 159,
  'packages/canvas-render/src/layout/edges/edge-crossing-sweep.ts#buildPairwiseScores': 52,
  'packages/canvas-render/src/layout/edges/edge-crossing-sweep.ts#scoreQuantizedSegmentPair': 53,
  'packages/canvas-render/src/layout/edges/grid-route.ts#routeOnGrid': 129,
  'packages/canvas-render/src/layout/edges/spatial-edges.ts#anchorsWithoutCoincidentEnds': 94,
  'packages/canvas-render/src/layout/edges/spatial-edges.ts#assignEdgeAnchors': 52,
  'packages/canvas-render/src/layout/edges/spatial-edges.ts#computeAnchorsFor': 89,
  'packages/canvas-render/src/layout/edges/spatial-edges.ts#createConfigScore': 250,
  'packages/canvas-render/src/layout/edges/spatial-edges.ts#createConfigScore.evaluateTrial': 82,
  'packages/canvas-render/src/layout/edges/spatial-edges.ts#initialSideChoices': 58,
  'packages/canvas-render/src/layout/edges/spatial-edges.ts#optimizeAcrossRegions': 111,
  'packages/canvas-render/src/layout/edges/spatial-edges.ts#optimizeSideChoices': 94,
  'packages/canvas-render/src/layout/edges/spatial-edges.ts#patchAnchorGroups': 54,
  'packages/canvas-render/src/layout/edges/spatial-edges.ts#routeEdge': 164,
  'packages/canvas-render/src/layout/edges/spatial-edges.ts#routeOrthogonal': 180,
  'packages/canvas-render/src/layout/nodes/mdast-blocks.ts#layoutBlock': 323,
  'packages/canvas-render/src/layout/nodes/mdast-blocks.ts#layoutCanvasEmbedBlock': 53,
  'packages/canvas-render/src/layout/nodes/mdast-blocks.ts#layoutListItem': 65,
  'packages/canvas-render/src/layout/nodes/mdast-blocks.ts#layoutPhrasing': 406,
  'packages/canvas-render/src/layout/nodes/mdast-blocks.ts#layoutPhrasing.emit': 89,
  'packages/canvas-render/src/layout/nodes/mdast-blocks.ts#layoutPhrasing.walk': 126,
  'packages/canvas-render/src/layout/nodes/mdast-blocks.ts#layoutPhrasing.wrapAndPush': 80,
  'packages/canvas-render/src/layout/proposals.ts#composeProposals': 110,
  'packages/canvas-render/src/layout/scale-scene.ts#scaleNode': 88,
  'packages/canvas-render/src/layout/spatial-canvas.ts#composeEdgesAndLabels': 68,
  'packages/canvas-render/src/layout/spatial-canvas.ts#composeNode': 93,
  'packages/canvas-render/src/layout/spatial-canvas.ts#composeTextNode': 63,
  'packages/canvas-render/src/layout/translate-scene.ts#translateNode': 65,
  'packages/canvas-render/src/quality/composition-score.ts#scoreComposition': 95,
  'packages/canvas-render/src/quality/drawing-score.ts#scoreDrawing': 63,
  'packages/canvas-render/src/quality/facet-score.ts#scoreFacets': 121,
  'packages/canvas-render/src/references/seams.ts#referenceSeams': 73,
  'packages/canvas-render/src/scene-bounds.ts#sceneBounds': 63,
  'packages/canvas-render/src/scene-digest.ts#computeFreeRegions': 52,
  'packages/canvas-render/src/svg/backend.ts#buildSvgDocumentParts': 61,
  'packages/canvas-render/src/svg/backend.ts#renderNode': 97,
  'packages/canvas-render/src/svg/backend.ts#renderTextRun': 83,
  'packages/canvas-render/src/svg/legend.ts#renderLegend': 75,
  'packages/canvas-render/src/svg/render-edge.ts#renderEdge': 69,
  'packages/canvas-render/src/svg/shapes.ts#renderCrispShape': 69,
  'packages/canvas-render/src/svg/shapes.ts#renderSketchShape': 58,
  'packages/canvas-render/src/test-utils/annotation-density-metrics.ts#scoreCommentDensity': 51,
  'packages/canvas-render/src/test-utils/annotation-density-metrics.ts#scoreProposalDensity': 51,
  'packages/canvas-render/src/test-utils/golden-scene.ts#buildDeterminismGoldenScene': 71,
  'packages/canvas-render/src/test-utils/routing-corpus.ts#clusteredLayout': 53,
  'packages/canvas-render/src/theme/spatial-theme.ts#buildTheme': 119,
  'packages/canvas-render/src/tidy-units.ts#buildUnits': 55,
  'packages/canvas-render/src/tidy.ts#alignBands': 92,
  'packages/canvas-render/src/tidy.ts#resolveOverlaps': 51,
  'packages/canvas-render/src/tidy.ts#tidyLevel': 148,
  'packages/canvas-viewer/src/CanvasViewer.tsx#CanvasViewer': 136,
  'packages/canvas-viewer/src/font-loading.ts#loadViewerFont': 61,
  'packages/canvas-viewer/src/widget-entry.ts#applyToolResult': 58,
  'packages/canvas-viewer/src/widget-entry.ts#mountFromHost': 224,
  'packages/canvas-viewer/src/widget-entry.ts#mountFromHost.submitComment': 64,
  'packages/canvas-viewer/src/widget/comment-control.ts#createCommentControl': 118,
  'packages/codec/src/markdown/from-remark.ts#toFlow': 59,
  'packages/codec/src/markdown/from-remark.ts#toPhrasing': 55,
  'packages/codec/src/markdown/normalize.ts#normalizeNode': 53,
  'packages/codec/src/references/scan.ts#findNextReference': 52,
  'packages/codec/src/spatial/loss-table.ts#jsonCanvasLossTable': 52,
  'packages/codec/src/spatial/ocif-projection-io.ts#projectNode': 51,
  'packages/codec/src/spatial/projection.ts#liftNode': 55,
  'packages/codec/src/test-utils/fully-populated-canvas.ts#fullyPopulatedCanvas': 92,
  'packages/daemon-client/src/daemon-backend.ts#openSocket': 142,
  'packages/daemon-client/src/replica-session-key.ts#sessionKey': 57,
  'packages/daemon-client/src/test-utils/document-backend-contract.ts#documentBackendContract': 102,
  'packages/daemon-client/src/test-utils/sse-stream-source-contract.ts#sseStreamSourceContract': 185,
  'packages/facet-engine/src/form.ts#deriveFacetForm': 52,
  'packages/facet-engine/src/form.ts#normalizePicker': 53,
  'packages/facet-engine/src/registry.ts#createFacetRegistry': 290,
  'packages/facet-ui/src/catalog-picker.tsx#CatalogPicker': 228,
  'packages/facet-ui/src/catalog-popover.tsx#CatalogPopover': 144,
  'packages/facet-ui/src/derived-form.tsx#DerivedFacetForm': 264,
  'packages/facet-ui/src/derived-form.tsx#FieldInput': 131,
  'packages/facet-ui/src/facet-catalog-picker.tsx#FacetCatalogPicker': 79,
  'packages/facet-ui/src/option-group.tsx#FacetOption': 77,
  'packages/history/src/checkpoints/scheduler.ts#createCheckpointScheduler': 99,
  'packages/loro-adapter/src/loro-bridge.ts#reconcileSpatialCanvas': 54,
  'packages/loro-adapter/src/loro-bridge.ts#writeSpatialCanvasInto': 82,
  'packages/loro-adapter/src/workspace-tree.ts#syncMapEntries': 54,
  'packages/loro-adapter/src/workspace-tree.ts#writeWorkspaceDocumentContent': 62,
  'packages/mcp-server/src/cli/daemon-doctor.ts#runDaemonDoctor': 73,
  'packages/mcp-server/src/cli/daemon-logs.ts#buildInputs': 65,
  'packages/mcp-server/src/cli/daemon-run.ts#runDaemonRun': 176,
  'packages/mcp-server/src/cli/daemon-status.ts#runDaemonStatus': 85,
  'packages/mcp-server/src/cli/daemon-stop.ts#runDaemonStop': 84,
  'packages/mcp-server/src/cli/daemon-support-bundle.ts#runDaemonSupportBundle': 121,
  'packages/mcp-server/src/cli/dispatcher.ts#dispatchRun': 67,
  'packages/mcp-server/src/cli/dispatcher.ts#main': 95,
  'packages/mcp-server/src/cli/search-fetch-model.ts#runSearchFetchModel': 63,
  'packages/mcp-server/src/cli/server-doctor.ts#runServerDoctor': 59,
  'packages/mcp-server/src/cli/server-restore.ts#runServerRestore': 98,
  'packages/mcp-server/src/cli/server-run.ts#runServerRun': 139,
  'packages/mcp-server/src/cli/server-status.ts#runServerStatus': 78,
  'packages/mcp-server/src/cli/server-stop.ts#runServerStop': 128,
  'packages/mcp-server/src/cli/server-support-bundle.ts#runServerSupportBundle': 105,
  'packages/mcp-server/src/daemon/ensure-daemon.ts#ensureDaemon': 84,
  'packages/mcp-server/src/di/container.ts#resolveServerDeps': 94,
  // 424 -> 433 (ADR-0041 S8 slice 2): the membership gate argument and the admit wiring threaded from membershipWiring().
  'packages/mcp-server/src/server/app.ts#createApp': 433,
  'packages/mcp-server/src/server/canvas-client-notifier.ts#createCanvasClientNotifier': 88,
  'packages/mcp-server/src/server/export/headless-renderer.ts#buildExporter': 70,
  // 431 -> 435 (ADR-0041 S8 slice 2): the WS upgrade's membership refusal call and the target binding it reads.
  'packages/mcp-server/src/server/http-server.ts#startHttpServer': 435,
  'packages/mcp-server/src/server/index.ts#main': 182,
  'packages/mcp-server/src/server/mcp/codex-config.distribution-impl.ts#runCodexConfigSmoke': 74,
  'packages/mcp-server/src/server/mcp/document-tools.ts#registerDocumentTools': 305,
  'packages/mcp-server/src/server/mcp/index.ts#createMcpServer': 88,
  'packages/mcp-server/src/server/mcp/index.ts#main': 61,
  'packages/mcp-server/src/server/mcp/mcp-e2e-checkpoint.smoke-impl.ts#runE2eCheckpointSmoke': 230,
  'packages/mcp-server/src/server/mcp/pairing-link.ts#registerPairingLinkTool': 74,
  'packages/mcp-server/src/server/mcp/startup.smoke-impl.ts#runStartupSmoke': 67,
  'packages/mcp-server/src/server/mcp/stdio-exit.smoke-impl.ts#runStdioExitSmoke': 115,
  'packages/mcp-server/src/server/mcp/stdio-lifecycle.ts#installStdioLifecycle': 68,
  'packages/mcp-server/src/server/mcp/tarball.distribution-impl.ts#assertSemanticSearchOptIn': 81,
  'packages/mcp-server/src/server/mcp/tarball.distribution-impl.ts#runPackedTarballSmoke': 131,
  'packages/mcp-server/src/server/mcp/tool-support.ts#registerToolWithAnnotations': 102,
  'packages/mcp-server/src/server/observability/http-tracing.ts#tracingMiddleware': 51,
  'packages/mcp-server/src/server/observability/tracing.ts#initTracing': 85,
  // 80 -> 81 (ADR-0041 S8 slice 2): threads the membership admit to the workspaces router.
  'packages/mcp-server/src/server/routes/document.ts#createDocumentRouter': 81,
  'packages/mcp-server/src/server/routes/document/export-svg.ts#createDocumentSvgExportRouter': 112,
  'packages/mcp-server/src/server/routes/document/live-doc.ts#createLiveDocRouter': 74,
  'packages/mcp-server/src/server/routes/document/maintenance.ts#createMaintenanceRouter': 101,
  'packages/mcp-server/src/server/routes/document/metadata.ts#createDocumentMetadataRouter': 88,
  'packages/mcp-server/src/server/routes/document/restore.ts#createRestoreRouter': 107,
  'packages/mcp-server/src/server/routes/document/trash.ts#createTrashRouter': 82,
  'packages/mcp-server/src/server/routes/document/versions.ts#createVersionsRouter': 132,
  'packages/mcp-server/src/server/routes/document/workspace-document.ts#createWorkspaceDocumentRouter': 178,
  // 406 -> 412 (ADR-0041 S8 slice 2): the workspace list filters rows the caller is not admitted to.
  'packages/mcp-server/src/server/routes/document/workspaces.ts#createWorkspacesRouter': 412,
  'packages/mcp-server/src/server/routes/export.ts#createExportRouter': 117,
  'packages/mcp-server/src/server/routes/files.ts#createFilesRouter': 142,
  'packages/mcp-server/src/server/routes/fonts.ts#createFontsRouter': 58,
  'packages/mcp-server/src/server/routes/mcp.ts#createMcpRouter': 120,
  'packages/mcp-server/src/server/routes/membership.ts#createMembershipRouter': 112,
  'packages/mcp-server/src/server/routes/oauth-authz.ts#createOAuthAuthzRouter': 208,
  'packages/mcp-server/src/server/routes/pairing.ts#createPairingRouter': 283,
  'packages/mcp-server/src/server/routes/replica-key.ts#createReplicaKeyRouter': 59,
  'packages/mcp-server/src/server/routes/runtime.ts#createRuntimeRouter': 146,
  // 109 -> 115 (ADR-0041 S8 slice 2): subscribe/message decide membership once per distinct workspace.
  'packages/mcp-server/src/server/routes/sync-sse.ts#createSyncSseRouter': 115,
  'packages/mcp-server/src/server/routes/viewport.ts#createViewportRouter': 71,
  // 75 -> 76 (ADR-0041 S8 slice 2): every accepted decision carries the resolved grant for the upgrade's membership check.
  'packages/mcp-server/src/server/routes/ws-auth.ts#authorizeWsUpgrade': 76,
  'packages/mcp-server/src/server/routes/ws.ts#handleWsUpgrade': 291,
  'packages/mcp-server/src/server/security/credential-resolver.ts#createCredentialResolver': 92,
  'packages/mcp-server/src/server/security/credential-resolver.ts#createCredentialResolver.resolve': 88,
  'packages/mcp-server/src/server/security/member-profile-store.ts#createMemberProfileStore': 108,
  'packages/mcp-server/src/server/security/oauth-authz-transactions.ts#createOAuthTransactionStore': 299,
  'packages/mcp-server/src/server/security/oauth-jwt-validator.ts#createOAuthJwtValidator': 88,
  'packages/mcp-server/src/server/security/oauth-jwt-validator.ts#createOAuthJwtValidator.validate': 63,
  'packages/mcp-server/src/server/security/oauth-resource-strategy.ts#createOAuthResourceServerAuthStrategy': 68,
  'packages/mcp-server/src/server/security/oauth-resource-strategy.ts#createOAuthResourceServerAuthStrategy.authorize': 62,
  'packages/mcp-server/src/server/security/origin-pattern.ts#parseOriginPatternEntry': 61,
  'packages/mcp-server/src/server/security/pairing-grant-store.ts#createPairingGrantStore': 67,
  'packages/mcp-server/src/server/security/pairing-session.ts#createPairingTokenStore': 55,
  'packages/mcp-server/src/server/security/server-mode-env-config.ts#parseServerModeEnvConfig': 90,
  'packages/mcp-server/src/server/security/server-mode-exposure.ts#resolveServerModeExposure': 91,
  'packages/mcp-server/src/server/security/webauthn-credential-store.ts#createWebAuthnCredentialStore': 65,
  'packages/mcp-server/src/server/security/ws-ticket-store.ts#createWsTicketStore': 52,
  'packages/mcp-server/src/server/server-mode-http.ts#startServerModeHttp': 202,
  'packages/mcp-server/src/server/store/auto-compact.ts#scheduleAutoCompact': 59,
  'packages/mcp-server/src/server/store/backup-in-progress.ts#withBackupMarker': 53,
  'packages/mcp-server/src/server/store/backup-pass.ts#performBackup': 214,
  'packages/mcp-server/src/server/store/backup-scheduler.ts#createBackupScheduler': 207,
  'packages/mcp-server/src/server/store/backup-subprocess.ts#runBackupInSubprocess': 64,
  'packages/mcp-server/src/server/store/db/index.ts#buildDb': 62,
  'packages/mcp-server/src/server/store/db/test-helpers.ts#createIsolatedDb': 54,
  'packages/mcp-server/src/server/store/document-store.ts#compactDocument': 93,
  'packages/mcp-server/src/server/store/document-store.ts#renameDocumentPath': 53,
  'packages/mcp-server/src/server/store/document-store.ts#saveDocument': 66,
  'packages/mcp-server/src/server/store/file-gc-sweeper.ts#createFileGcSweeper': 124,
  'packages/mcp-server/src/server/store/file-gc-sweeper.ts#discoverFsWorkspaces': 78,
  'packages/mcp-server/src/server/store/file-gc.ts#purgeDanglingFiles': 110,
  'packages/mcp-server/src/server/store/libsql/libsql-document-store.ts#saveCompactedSnapshot': 75,
  'packages/mcp-server/src/server/store/version-store.ts#save': 100,
  'packages/mcp-server/src/server/store/workspace-tail.ts#createWorkspaceTail': 90,
  'packages/mcp-server/src/shared/diagnostics/support-bundle-writer.ts#writeSupportBundle': 53,
  'packages/mcp-server/src/shared/test-utils/tool-surface-metrics.ts#parameterCoverage': 63,
  'packages/model/src/proposal-apply.ts#applyCanvasChange': 80,
  'packages/model/src/test-utils/zod-arbitrary.ts#walkShape': 132,
  'packages/model/src/text-anchor.ts#resolveTextAnchor': 67,
  'packages/ports/src/snapshot-helpers.ts#reassembleSnapshot': 94,
  'packages/ports/src/test-utils/blob-store-conformance.ts#describeBlobStoreConformance': 127,
  'packages/ports/src/test-utils/document-index-conformance.ts#describeDocumentIndexConformance': 673,
  'packages/ports/src/test-utils/document-store-conformance.ts#describeDocumentStoreConformance': 662,
  'packages/server-core/src/create-server.ts#createServer': 219,
  'packages/server-core/src/operations/restore-version.ts#restoreSubtree': 67,
  'packages/server-core/src/operations/restore-version.ts#restoreToTarget': 61,
  'packages/server-core/src/references/content-facts-cache.ts#vectorsFor': 51,
  'packages/server-core/src/test-utils/seeded-workspace.ts#seededServer': 73,
  'packages/server-core/src/tools/body-edit.ts#createBodyEditTool': 70,
  'packages/server-core/src/tools/canvas-edit.ts#createCanvasEditTool': 222,
  'packages/server-core/src/tools/canvas-edit.ts#createCanvasEditTool.execute': 213,
  'packages/server-core/src/tools/canvas-render-svg.ts#createCanvasRenderSvgTool': 75,
  'packages/server-core/src/tools/canvas-render-svg.ts#createCanvasRenderSvgTool.execute': 66,
  'packages/server-core/src/tools/canvas-view.ts#createCanvasViewTool': 59,
  'packages/server-core/src/tools/document-crud.ts#wbDocumentCreate': 130,
  'packages/server-core/src/tools/document-search.ts#createDocumentSearchTool': 181,
  'packages/server-core/src/tools/document-search.ts#createDocumentSearchTool.execute': 169,
  'packages/server-core/src/tools/document-set.ts#createDocumentSetTool': 110,
  'packages/server-core/src/tools/facet-list.ts#createFacetListTool': 87,
  'packages/server-core/src/tools/facet-set.ts#createFacetSetTool': 120,
  'packages/server-core/src/tools/facet-set.ts#setOne': 92,
  'packages/server-core/src/tools/linkify-mentions.ts#linkifyMentions': 56,
  'packages/server-core/src/tools/version-restore.ts#createVersionRestoreTool': 64,
  'packages/workspace-index/src/document-store-workspace-docs.ts#save': 93,
  'packages/workspace-index/src/loro-workspace-document-index.ts#deleteDocument': 53,
  'packages/workspace-index/src/loro-workspace-document-index.ts#moveDocument': 64,
  'tools/arch-lint/src/scanner.ts#collectModuleSpecifiers': 61,
  'tools/arch-lint/src/source-scan.ts#stripCommentsAndStrings': 54,
}

/**
 * Test-file functions over the SAME budget, on the same shrink-only
 * contract, for the reason `file-size-budget.test.ts` gives its own test
 * ledger: a fixture is code someone has to read too, and a separate softer
 * budget would be a second rule nobody agreed.
 */
const TEST_FUNCTION_SIZE_GRANDFATHER: Record<string, number> = {
  'apps/web/src/App.daemon-address.test.tsx#installDaemonFetch': 55,
  'apps/web/src/components/settings/PromoteWorkspaceSection.browser.test.tsx#daemonStub': 81,
  'apps/web/src/components/spatial-editor/editor-state.property.test.ts#checkInvariants': 80,
  'apps/web/src/components/spatial-editor/editor-state.property.test.ts#run~23': 127,
  'apps/web/src/components/spatial-editor/navigation.property.test.ts#drive': 137,
  'apps/web/src/lib/browser-idb-migration.browser.test.tsx#seedV13Fixture': 79,
  'apps/web/src/lib/browser-idb-migration.browser.test.tsx#seedV18Fixture': 61,
  'apps/web/src/lib/browser-idb-migration.browser.test.tsx#seedV19Fixture': 93,
  'apps/web/src/lib/promote-workspace.browser.test.tsx#daemonStub': 52,
  'apps/web/src/lib/versions-backend.contract.browser.test.tsx#browserHarness': 74,
  'apps/web/src/lib/versions-backend.contract.browser.test.tsx#daemonHarness': 83,
  'apps/web/src/pages/DaemonIndexPage.test.tsx#installFetchMock': 93,
  'packages/canvas-render/src/layout/edges/edge-crossing-sweep-narrow-phase.test.ts#referenceScore': 53,
  'packages/canvas-render/src/layout/edges/grid-route.optimality.properties.test.ts#referenceCost': 106,
  'packages/codec/src/markdown/round-trip.property.test.ts#hasNoExcludedDescendant': 88,
  'packages/daemon-client/src/sse-stream-hub.contract.test.ts#createHarness': 83,
  'packages/mcp-server/src/cli/argv.differential.test.ts#oldParseDaemonRunArgs': 87,
  'packages/mcp-server/src/cli/argv.differential.test.ts#oldParseDaemonSupportBundleArgs': 54,
  'packages/mcp-server/src/cli/daemon-run-auto-open-launch.test.ts#launchDaemonInPty': 70,
  'packages/mcp-server/src/cli/server-args.differential.test.ts#oldBackup': 64,
  'packages/mcp-server/src/server/app.routes.fuzz.property.test.ts#fillPattern': 65,
  'packages/mcp-server/src/server/mcp/tool-call-count-quality.test.ts#harness': 77,
  'packages/mcp-server/src/server/routes/replica-key.test.ts#bindSession': 64,
  'packages/mcp-server/src/server/security/server-mode-env-config.differential.test.ts#parseOld': 157,
  'packages/server-core/src/tools/tool-inputs.fuzz.property.test.ts#fitCanvasOp': 89,
  'packages/workspace-index/src/loro-workspace-document-index.test.ts#inMemoryWorkspaceDocs': 58,
}

function ledgerFor(isTest: boolean): Record<string, number> {
  return isTest ? TEST_FUNCTION_SIZE_GRANDFATHER : FUNCTION_SIZE_GRANDFATHER
}

describe('functions stay under the line budget, or are recorded shrinking', () => {
  // A scan that stops matching reports its subject as satisfied — the same
  // shape as a passing run. Both halves are checked before anything below is
  // concluded from it.
  it('measured a plausible number of functions, across the repo', () => {
    expect(MEASURED.length).toBeGreaterThan(4000)
    expect(new Set(MEASURED.map((row) => row.key.split('#')[0])).size).toBeGreaterThan(800)
  })

  it('holds no un-recorded function over the budget', () => {
    const unlisted = MEASURED.filter(
      (row) => row.lines > LINE_BUDGET && !(row.key in ledgerFor(row.isTest)),
    ).map(
      (row) =>
        `${row.key}: ${row.lines} lines, over the ${LINE_BUDGET}-line budget and not recorded — split it, or add it here with a reason in the diff`,
    )

    expect(unlisted).toEqual([])
  })

  it('holds no recorded function that has grown past its ceiling', () => {
    const grown = MEASURED.filter((row) => {
      const ceiling = ledgerFor(row.isTest)[row.key]
      return ceiling !== undefined && row.lines > ceiling
    }).map((row) => {
      const ceiling = ledgerFor(row.isTest)[row.key]
      return `${row.key}: ${row.lines} lines, over its recorded ceiling of ${String(ceiling)} — shrink it back, or raise the ceiling here deliberately`
    })

    expect(grown).toEqual([])
  })

  it('holds no entry that has shrunk to budget — delete it instead', () => {
    const shrunk = [
      ...Object.keys(FUNCTION_SIZE_GRANDFATHER),
      ...Object.keys(TEST_FUNCTION_SIZE_GRANDFATHER),
    ]
      .filter((key) => {
        const lines = BY_KEY.get(key)
        return lines !== undefined && lines <= LINE_BUDGET
      })
      .map(
        (key) =>
          `${key}: ${String(BY_KEY.get(key))} lines, at or under the ${LINE_BUDGET}-line budget`,
      )

    expect(shrunk).toEqual([])
  })

  it('holds no entry for a function that was renamed, moved or deleted', () => {
    const missing = [
      ...Object.keys(FUNCTION_SIZE_GRANDFATHER),
      ...Object.keys(TEST_FUNCTION_SIZE_GRANDFATHER),
    ].filter((key) => !BY_KEY.has(key))

    expect(missing).toEqual([])
  })

  // The source scan excludes test files and the test ledger requires them, so
  // an overlap means one of the two filters drifted.
  it('shares no key between the two ledgers', () => {
    const shared = Object.keys(TEST_FUNCTION_SIZE_GRANDFATHER).filter(
      (key) => key in FUNCTION_SIZE_GRANDFATHER,
    )

    expect(shared).toEqual([])
  })
})
