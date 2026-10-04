import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type MeasuredFunction, measureSource } from './function-size-measure.js'
import { isExcludedPath, REPO_ROOT, relativeToRepo, SCAN_ROOTS, walk } from './scan-roots.js'
import { registerSizeLedgerAssertions } from './size-ledger-assertions.js'

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
// entry. An entry is a CEILING, not a reading, so an ordinary shrink needs
// no edit here — only crossing the budget, growing past the recorded number,
// or leaving the ceiling standing further above the reading than
// `size-ledger-headroom.ts` allows does. That last one is what keeps the
// growth guard a guard: a ceiling 584 lines above its function holds nothing.
//
// **Why a per-file budget could not catch this class, measured.** A change
// that moved 834 lines of pointer handling out of `SpatialEditor.tsx` into
// `use-editor-pointer.ts`. Both files ended under 800, `file-size-budget`
// stayed green, and the diff read as a decomposition — but the 834 lines are
// still ONE function (`useEditorPointer`, among the largest in the repo).
// Relocating mass satisfies a file budget while the function survives whole.
//
// **Why it lives in `tools/arch-lint` rather than beside its sibling.** The
// AST comes from `@typescript/typescript6`, which only this package depends
// on, and `architecture-map.md` puts cross-package source scans here — every
// guard in this project reads OTHER packages' source, which is why the whole
// project runs at pre-push. `file-size-budget.test.ts` is still named a
// pre-push command of its own; this one needs no new line.
//
// **Why the list runs to hundreds of entries and not 17.** That is what the rule's drift
// actually costs — measured, not chosen. At a budget of 100 it would be 161
// entries, at 150 it would be 86; picking one of those would be picking the
// number that makes the debt look smaller, over the number the checklist
// states. The list is data rather than prose for the same reason.
const LINE_BUDGET = 50

type Measured = MeasuredFunction

function measureFile(absolutePath: string, relativePath: string): Measured[] {
  return measureSource(readFileSync(absolutePath, 'utf8'), relativePath)
}

// The same two directory exclusions `file-size-budget.test.ts` makes, from the
// same place (`scan-roots.ts`), for the same reasons.
const MEASURED: readonly Measured[] = SCAN_ROOTS.flatMap((relDir) =>
  walk(join(REPO_ROOT, relDir), {
    include: (absolutePath) =>
      /\.tsx?$/.test(absolutePath) &&
      !absolutePath.endsWith('.d.ts') &&
      !isExcludedPath(absolutePath),
  }).flatMap((absolutePath) => measureFile(absolutePath, relativeToRepo(absolutePath))),
)

const BY_KEY = new Map(MEASURED.map((row) => [row.key, row.lines]))

/**
 * Source functions over the budget when this guard landed, each with the
 * ceiling it had then. Shrink-only: see the header.
 */
const FUNCTION_SIZE_GRANDFATHER: Record<string, number> = {
  'apps/web/src/App.tsx#App': 179,
  // The chrome row `AppShell`, the MODE choice, picks. Still over budget
  // because it is a row of controls and their rationale; the four that could
  // stand alone (the mark's frame, the alpha badge, fullscreen, settings) did.
  'apps/web/src/components/AppShell.tsx#ShellBar': 105,
  'apps/web/src/components/VersionPreview.tsx#PastCanvasPreview': 67,
  'apps/web/src/components/EditorExitHint.tsx#EditorExitHint': 109,
  'apps/web/src/components/FontsCard.tsx#FontsCard': 129,
  'apps/web/src/components/StorageReportCard.tsx#StorageReportCard': 275,
  'apps/web/src/components/VersionTimeline.tsx#VersionTimeline': 278,
  'apps/web/src/components/WorkspaceTopBar.tsx#WorkspaceTopBar': 102,
  'apps/web/src/components/annotations/CommentBody.tsx#CommentBody': 64,
  'apps/web/src/components/annotations/CommentComposer.tsx#CommentComposer': 69,
  // The thread row lives in `thread-row.tsx`.
  'apps/web/src/components/annotations/CommentsPanel.tsx#CommentsPanel': 311,
  // The row the panel's list is made of, split three ways: the row and its
  // verbs, the open conversation, and the messages inside it. Each is a
  // block of JSX rather than a branch — the shape a size budget cannot tell
  // from logic and a complexity budget can, and all three are now UNDER the
  // complexity threshold, which is what the split was for. Splitting
  // further would cut a single visual unit in half without a reader gaining
  // anything.
  'apps/web/src/components/annotations/thread-row.tsx#ThreadRow': 155,
  'apps/web/src/components/annotations/thread-row.tsx#ThreadConversation': 57,
  'apps/web/src/components/annotations/thread-row.tsx#ThreadMessages': 92,
  'apps/web/src/components/annotations/ReplyComposer.tsx#ReplyComposer': 54,
  'apps/web/src/components/connection/ConnectionStatus.tsx#ConnectionStatus': 61,
  'apps/web/src/components/document-editor/DocumentPageShell.tsx#DocumentPageShell': 92,
  'apps/web/src/components/document-editor/InspectorPanel.tsx#InspectorPanel': 139,
  'apps/web/src/components/document-editor/InspectorSegment.tsx#InspectorSegment': 56,
  'apps/web/src/components/document-editor/NodeTextEditorOverlay.tsx#NodeTextEditorOverlay': 103,
  'apps/web/src/components/document-editor/SpatialEditorPane.tsx#SpatialEditorPane': 88,
  'apps/web/src/components/document-editor/use-node-in-editor.tsx#useNodeInEditor': 56,
  'apps/web/src/components/document-properties/DocumentProperties.tsx#DocumentFacetsEditor': 117,
  'apps/web/src/components/document-properties/DocumentProperties.tsx#DocumentProperties': 110,
  'apps/web/src/components/markdown-editor/EditorToolbar.tsx#EditorToolbar': 135,
  'apps/web/src/components/markdown-editor/LinkPickerDialog.tsx#LinkPickerDialog': 160,
  // The two COLUMNS live in `editor-columns.tsx`, the split's drag in
  // `split-divider.tsx`, the pane scroll sync in `use-pane-scroll-sync.ts` and
  // its geometry in `preview-geometry.ts`. What is left is the editor's own
  // state and the frame it hangs the columns in — still the largest component
  // in the app, and the next cut is a further layer rather than another slot
  // (measured: lifting a slot moves the complexity by about one, because the
  // condition that decides whether to render it stays).
  'apps/web/src/components/markdown-editor/MarkdownEditor.tsx#MarkdownEditor': 616,
  // Both are the editor's own JSX, one level out: a column is a frame plus
  // the branches that decide what it draws, and those branches were the
  // editor's complexity rather than its structure.
  'apps/web/src/components/markdown-editor/editor-columns.tsx#PreviewColumn': 80,
  'apps/web/src/components/markdown-editor/editor-columns.tsx#SourceColumn': 53,
  'apps/web/src/components/markdown-editor/MarkdownVerbBar.tsx#MarkdownVerbBar': 60,
  'apps/web/src/components/markdown-editor/MinimapRail.tsx#MinimapRail': 80,
  'apps/web/src/components/markdown-editor/PassageProposalCard.tsx#PassageProposalCard': 63,
  'apps/web/src/components/markdown-editor/PreviewPane.tsx#PreviewPane': 52,
  'apps/web/src/components/markdown-editor/SourcePane.tsx#SourcePane': 258,
  'apps/web/src/components/markdown-editor/TouchFormattingBarPanel.tsx#TouchFormattingBarPanel': 128,
  'apps/web/src/components/markdown-editor/annotation-decorations.ts#annotationDecorations': 74,
  // The `ViewPlugin.define` callback of a module-level constant: one closure over the
  // tap's state and the three listeners that read it.
  'apps/web/src/components/markdown-editor/completion-popup.ts#completionTouchAccept': 98,
  'apps/web/src/components/markdown-editor/editor-verbs.ts#wrapSelectionWith': 63,
  'apps/web/src/components/markdown-editor/proposal-decorations.ts#proposalDecorations': 71,
  'apps/web/src/components/markdown-editor/verb-catalog.tsx#verbCatalogItems': 64,
  // A Settings card of the same shape as its two neighbours below: the rows,
  // the shared confirm dialog and the two-step delete are one screen's worth of
  // state, and the row already IS extracted (`CopyRowItem`). Splitting further
  // would separate the dialog from the `pending`/`deleting` state that decides
  // whether it may close. The registry read degrades: a browser that refuses
  // IndexedDB has to leave the card listing what it CAN read rather than
  // rejecting, and that branch is where the explanation lives.
  'apps/web/src/components/settings/LocalCopiesCard.tsx#LocalCopiesCard': 125,
  // The passkey states are a component, and the cache-then-maybe-demote step is
  // its own function (below) — which is where the reason its read-back has a
  // try/catch of its own lives.
  'apps/web/src/components/settings/PromoteWorkspaceSection.tsx#PromoteWorkspaceSection': 352,
  'apps/web/src/components/settings/PromoteWorkspaceSection.tsx#cacheAndMaybeDemote': 70,
  // The ladder is `journeySteps` and one function per rung, so "which state is
  // this environment in" is answered once rather than in the middle of the list
  // that draws it.
  'apps/web/src/components/settings/SetupJourney.tsx#SetupJourney': 81,
  'apps/web/src/components/shell/ShellMark.tsx#ShellMark': 80,
  'apps/web/src/components/shell/WorkspaceMenu.tsx#WorkspaceMenu': 212,
  'apps/web/src/components/spatial-editor/BoxTargetOverlay.tsx#BoxTargetOverlay': 95,
  // The six-level nested ternary choosing a menu is two named halves, which
  // costs the doc comments that say what each claims. The functions that split
  // created are long without being complex — each is a flat sequence of builder
  // calls or JSX props, which is what splitting a nested conditional into named
  // arms costs in LINES.
  'apps/web/src/components/spatial-editor/CanvasContextMenu.tsx#CanvasContextMenu.contentItems': 90,
  'apps/web/src/components/spatial-editor/ContextMenu.tsx#ContextMenu.renderOptionsRow': 68,
  'apps/web/src/components/spatial-editor/context-menu-items/node-menu-items.tsx#pushFrameBands': 66,
  'apps/web/src/components/spatial-editor/navigation.ts#reduceTouchPress': 65,
  'apps/web/src/components/spatial-editor/CanvasContextMenu.tsx#CanvasContextMenu': 218,
  'apps/web/src/components/spatial-editor/CanvasDisplaySettings.tsx#CanvasDisplaySettings': 97,
  'apps/web/src/components/spatial-editor/CommentThreadCard.tsx#CommentThreadCard': 191,
  // One branch per item kind instead of a nested JSX ternary.
  'apps/web/src/components/spatial-editor/ContextMenu.tsx#ContextMenu': 259,
  'apps/web/src/components/spatial-editor/DocumentPickerDialog.tsx#DocumentPickerDialog': 62,
  'apps/web/src/components/spatial-editor/DragPreviewLayer.tsx#DragPreviewLayer': 80,
  'apps/web/src/components/spatial-editor/EdgeBendHandles.tsx#EdgeBendHandles': 102,
  'apps/web/src/components/spatial-editor/EdgeEndHandles.tsx#EdgeEndHandles': 68,
  'apps/web/src/components/spatial-editor/EdgeSelectionHighlight.tsx#EdgeSelectionHighlight': 52,
  'apps/web/src/components/spatial-editor/LegendOverlay.tsx#LegendOverlay': 73,
  'apps/web/src/components/spatial-editor/LinkEmbedLayer.tsx#LinkEmbedLayer': 98,
  'apps/web/src/components/spatial-editor/LinkUrlDialog.tsx#LinkUrlDialog': 83,
  'apps/web/src/components/spatial-editor/MarkdownNodeEditor.tsx#MarkdownNodeEditor': 246,
  'apps/web/src/components/spatial-editor/MemberOutlinesOverlay.tsx#MemberOutlinesOverlay': 61,
  'apps/web/src/components/spatial-editor/MinimapOverlay.tsx#MinimapOverlay': 108,
  'apps/web/src/components/spatial-editor/ProposalCard.tsx#ProposalCard': 160,
  'apps/web/src/components/spatial-editor/SelectionOverlay.tsx#SelectionOverlay': 319,
  'apps/web/src/components/spatial-editor/SnapGuidesOverlay.tsx#SnapGuidesOverlay': 76,
  // The editor's JSX, cut into the layers it always had: canvas space under
  // the pan/zoom transform, screen space above it, the chrome you press, the
  // dialogs that chrome opens, and what is drawn about the selection. Each
  // is a block of JSX rather than a branch — the shape a size budget cannot
  // tell from logic and a complexity budget can — and all eight are now
  // UNDER the complexity threshold, which is what the cut was for.
  //
  // FUNCTIONS rather than components, and rather than a sibling module: each
  // layer reads this render's live gesture state, so a component would thread
  // roughly forty values through props — a wider seam, in the app's most
  // stateful surface, for no reader benefit. The tree they build is exactly
  // the tree the inline JSX built.
  // The component itself: a `forwardRef` function expression, the largest
  // function in the repo. The entries below are functions inside it, so their
  // keys carry its name.
  'apps/web/src/components/spatial-editor/SpatialEditor.tsx#SpatialEditor': 1632,
  // Its gesture and reach overlays live in `gesture-overlays.tsx`.
  'apps/web/src/components/spatial-editor/SpatialEditor.tsx#SpatialEditor.canvasSpaceLayers': 89,
  'apps/web/src/components/spatial-editor/SpatialEditor.tsx#SpatialEditor.screenSpaceOverlays': 53,
  'apps/web/src/components/spatial-editor/SpatialEditor.tsx#SpatialEditor.canvasChrome': 100,
  // The document picker and the URL dialog live in
  // `node-target-dialogs.tsx`; what is left is the context menu's wiring.
  'apps/web/src/components/spatial-editor/SpatialEditor.tsx#SpatialEditor.canvasDialogs': 62,
  'apps/web/src/components/spatial-editor/SpatialEditor.tsx#SpatialEditor.runNavigation': 55,
  'apps/web/src/components/spatial-editor/TextNodeEditor.tsx#TextNodeEditor': 91,
  'apps/web/src/components/spatial-editor/ToolPalette.tsx#ToolPalette': 259,
  'apps/web/src/components/spatial-editor/comment-compose-overlay.tsx#CommentComposeOverlay': 96,
  'apps/web/src/components/spatial-editor/context-menu-items/canvas-menu-items.tsx#canvasMenuItems': 91,
  'apps/web/src/components/spatial-editor/context-menu-items/color-row.tsx#colorRow': 55,
  'apps/web/src/components/spatial-editor/context-menu-items/edge-menu-items.tsx#edgeMenuItems': 93,
  'apps/web/src/components/spatial-editor/context-menu-items/ink-menu-items.tsx#inkMenuItems': 166,
  'apps/web/src/components/spatial-editor/context-menu-items/node-menu-items.tsx#nodeMenuItems': 275,
  'apps/web/src/components/spatial-editor/drag-preview.ts#computeDragPreview': 102,
  'apps/web/src/components/spatial-editor/facet-widgets/FacetFormPanel.tsx#FacetFormPanel': 132,
  'apps/web/src/components/spatial-editor/gesture-trace.ts#createGestureTrace': 83,
  'apps/web/src/components/spatial-editor/gestures.ts#reduceGesture': 77,
  'apps/web/src/components/spatial-editor/gestures.ts#reducePointerUpResizing': 52,
  'apps/web/src/components/spatial-editor/label-editor-overlays.tsx#EdgeLabelEditorOverlay': 59,
  'apps/web/src/components/spatial-editor/markdown-body-editor-overlay.tsx#MarkdownBodyEditorOverlay': 109,
  'apps/web/src/components/spatial-editor/pointer-release.ts#commitRelease': 81,
  'apps/web/src/components/spatial-editor/pointer-release.ts#releaseMarquee': 78,
  'apps/web/src/components/spatial-editor/use-canvas-replacement.ts#useCanvasReplacement': 86,
  'apps/web/src/components/spatial-editor/use-clipboard-actions.ts#useClipboardActions': 228,
  'apps/web/src/components/spatial-editor/use-clipboard-actions.ts#useClipboardActions.pasteFragment': 65,
  'apps/web/src/components/spatial-editor/use-comment-state.ts#useCommentState': 124,
  'apps/web/src/components/spatial-editor/use-drag-layers.ts#useDragLayers': 357,
  'apps/web/src/components/spatial-editor/use-edit-session-state.ts#useEditSessionState': 125,
  // `handleKeyDown` is a claimant chain, and each claimant carries the reason
  // that used to sit beside its `return`.
  'apps/web/src/components/spatial-editor/use-editor-keyboard.ts#useEditorKeyboard': 421,
  'apps/web/src/components/spatial-editor/use-editor-keyboard.ts#useEditorKeyboard.handleResizeHandleKeyDown': 74,
  // The press and release paths are claimant chains, and the reasons live on the
  // claimants. The comment, proposal, ink and context-menu claimants live in
  // `pointer-comment-claim.ts`, `pointer-proposal-claim.ts`,
  // `pointer-ink-claim.ts` and `pointer-menu-claim.ts`. The hook is still mass
  // that belongs in a module of its own — `pointer-release.ts` is the
  // precedent, and a press-side module beside it is the cut that brings this
  // down rather than a ceiling that keeps rising.
  'apps/web/src/components/spatial-editor/use-editor-pointer.ts#useEditorPointer': 548,
  'apps/web/src/components/spatial-editor/use-file-seam-scene.ts#useFileSeamScene': 93,
  'apps/web/src/components/spatial-editor/use-interaction-state.ts#useInteractionState': 139,
  'apps/web/src/components/spatial-editor/use-keyboard-avoidance.ts#useKeyboardAvoidance': 95,
  'apps/web/src/components/spatial-editor/use-lock-policy.ts#useLockPolicy': 72,
  'apps/web/src/components/spatial-editor/use-native-canvas-listeners.ts#useNativeCanvasListeners': 127,
  'apps/web/src/components/spatial-editor/use-node-creation.ts#useNodeCreation': 147,
  'apps/web/src/components/spatial-editor/use-scene-projection.ts#useSceneProjection': 150,
  'apps/web/src/components/spatial-editor/use-worker-scene.ts#useWorkerScene': 217,
  'apps/web/src/components/tags/TagChipsEditor.tsx#TagChipsEditor': 96,
  'apps/web/src/components/use-preview-viewport.ts#usePreviewViewport': 97,
  'apps/web/src/components/workspace-files/DocumentMinimap.tsx#DocumentMinimap': 85,
  'apps/web/src/components/workspace-files/DocumentPathField.tsx#DocumentPathField': 72,
  'apps/web/src/components/workspace-files/DocumentPreview.tsx#DocumentPreview': 167,
  'apps/web/src/components/workspace-files/DocumentThumbnail.tsx#DocumentThumbnail': 83,
  'apps/web/src/components/workspace-files/EmptyWorkspaceState.tsx#EmptyWorkspaceState': 75,
  // A document's card, and the picture with the two things drawn ON it, are
  // their own components. The two below are those.
  'apps/web/src/components/workspace-files/FolderContentsList.tsx#FolderContentsList': 79,
  'apps/web/src/components/workspace-files/FolderContentsList.tsx#CardThumbnail': 68,
  'apps/web/src/components/workspace-files/FolderContentsList.tsx#DocumentCard': 102,
  'apps/web/src/components/workspace-files/NewDocumentDialog.tsx#NewDocumentDialog': 165,
  'apps/web/src/components/workspace-files/NewDocumentMenu.tsx#NewDocumentMenu': 139,
  'apps/web/src/components/workspace-files/RecentLane.tsx#RecentLane': 53,
  'apps/web/src/components/workspace-files/RenameDocumentDialog.tsx#RenameDocumentDialog': 103,
  // The two layouts are ONE card with a `layout`. The entry below is that card
  // — the whole of what both layouts draw, counted once.
  'apps/web/src/components/workspace-files/SearchResults.tsx#SearchResults': 114,
  'apps/web/src/components/workspace-files/SearchResults.tsx#SearchResultCard': 102,
  'apps/web/src/components/workspace-files/TrashSection.tsx#TrashSection': 82,
  'apps/web/src/components/workspace-files/WorkspaceFileTree.tsx#DocumentRow': 57,
  'apps/web/src/components/workspace-files/WorkspaceFileTree.tsx#TreeItem': 51,
  // The two list effects do not repeat one another on a mount; the lines are the
  // guard plus the paragraph saying which run it skips and which it must not.
  // The toolbar, the refusals, the object pane, the card menu's items and each
  // column view live in `workspace-files-panel-parts.tsx`. The four entries
  // there are those — every one a block of JSX or a table of menu rows, which
  // is the shape a LINE budget cannot tell from logic and the complexity budget
  // can: all four are under the complexity threshold.
  'apps/web/src/components/workspace-files/WorkspaceFilesPanel.tsx#WorkspaceFilesPanel': 779,
  'apps/web/src/components/workspace-files/WorkspaceFilesPanel.tsx#WorkspaceFilesPanel.renderColumns': 91,
  'apps/web/src/components/workspace-files/workspace-files-panel-parts.tsx#PanelToolbar': 92,
  'apps/web/src/components/workspace-files/workspace-files-panel-parts.tsx#cardMenuItemsFor': 94,
  'apps/web/src/components/workspace-files/workspace-files-panel-parts.tsx#BrowseTwoColumns': 81,
  'apps/web/src/components/workspace-files/workspace-files-panel-parts.tsx#SearchColumn': 74,
  'apps/web/src/components/workspace-files/use-debounced-document-search.ts#useDebouncedDocumentSearch': 60,
  'apps/web/src/components/workspace-files/use-device-memory.ts#useDeviceMemory': 62,
  'apps/web/src/components/workspace-files/use-long-press.ts#useLongPressMenu': 65,
  'apps/web/src/components/workspace-files/use-rename-document.ts#useRenameDocument': 63,
  'apps/web/src/components/workspace-top-bar/BookmarkAction.tsx#BookmarkAction': 112,
  'apps/web/src/components/workspace-top-bar/useDocumentNames.ts#useDocumentNames': 55,
  'apps/web/src/hooks/use-comments-rail.ts#useCommentsRail': 187,
  'apps/web/src/hooks/use-document-favicon.ts#useDocumentFavicon': 52,
  'apps/web/src/hooks/use-document-file-seams.ts#useDocumentFileSeams': 118,
  'apps/web/src/hooks/use-image-urls.ts#useImageUrls': 67,
  'apps/web/src/hooks/use-reference-seams.ts#useReferenceSeams': 63,
  'apps/web/src/hooks/use-shell-workspaces.ts#useShellWorkspaces': 107,
  // The receiving half of a cross-origin transfer, as one sequence: announce,
  // listen, accept, report. The workspace list is already split out
  // (`useKeeperWorkspaceTargets`) because it is a different question; what
  // remains reads top to bottom as the handshake, and splitting it further
  // would scatter one protocol across hooks.
  'apps/web/src/hooks/use-transfer-handshake.ts#useTransferHandshake': 86,
  // The awaitingDaemonRenewal guard (ADR-0042): a daemon deep link is
  // undecided, not foreign, while its silent renewal is outstanding.
  'apps/web/src/hooks/use-workspace-address-sync.ts#useWorkspaceAddressSync': 193,
  'apps/web/src/hooks/useDocumentOutline.ts#useDocumentOutline': 68,
  'apps/web/src/hooks/useDocumentSync.ts#useDocumentSync': 362,
  'apps/web/src/lib/browser-idb.ts#openWhiteboardDb': 54,
  'apps/web/src/lib/browser-version-store.ts#save': 58,
  'apps/web/src/lib/browser-versions-backend.ts#createBrowserVersionsBackend': 59,
  'apps/web/src/lib/clipboard-fragment.ts#remintClipboardFragment': 55,
  'apps/web/src/lib/daemon-file-adapter.ts#createDaemonFileAdapter': 70,
  'apps/web/src/lib/daemon-files-source.ts#createDaemonFilesSource': 94,
  'apps/web/src/lib/command-writes.ts#commandTargetKey': 56,
  // The undo path takes back a write still inside the debounce window, which
  // has to reach the timer and the queue this factory closes over — so it
  // lives here rather than beside them. Shrinking it is the next shrink
  // `file-size-budget.test.ts` names for this file: the history/undo group and
  // the locks lifted as sub-modules, the undo one handed `dropQueuedWrite`
  // rather than the queue itself. Both document pages already sit behind one
  // `DocumentBackend`, so that port is not what is left to do.
  'apps/web/src/lib/document-sync-session.ts#createDocumentSyncSession': 864,
  'apps/web/src/lib/document-sync-session.ts#createDocumentSyncSession.connect': 186,
  'apps/web/src/lib/document-sync-session.ts#createDocumentSyncSession.connect.onSnapshot': 87,
  'apps/web/src/lib/command-writes.ts#writeCommandTarget': 140,
  'apps/web/src/lib/fold-workspace.ts#foldWorkspaceDocuments': 56,
  'apps/web/src/lib/idb-document-store.ts#loadSnapshot': 60,
  'apps/web/src/lib/keyed-svg-patcher.ts#mountKeyedSvg': 76,
  'apps/web/src/lib/layout-worker-pool.ts#createLayoutWorkerPool': 153,
  'apps/web/src/lib/layout-worker.ts#handleLayout': 67,
  'apps/web/src/lib/local-files-source.ts#createLocalFilesSource': 270,
  'apps/web/src/lib/loro-store.ts#appendDelta': 73,
  // The credential negotiates the `prf` extension at CREATE (ADR-0042 d6),
  // which several authenticators decide there rather than at assertion time.
  // One property on the options object; its reasoning is a named constant
  // beside the function rather than a comment inside it.
  'apps/web/src/lib/promote-workspace.ts#promoteWorkspaceUnsafe': 79,
  'apps/web/src/lib/spatial/commands.ts#applyCommand': 132,
  'apps/web/src/lib/spatial/fragment-insert.ts#buildFragmentInsertCommand': 84,
  'apps/web/src/lib/spatial/freehand.ts#freehandLine': 58,
  'apps/web/src/lib/spatial/geometry.ts#findFreeSpot': 64,
  'apps/web/src/lib/spatial/minimap.ts#fitMinimap': 52,
  'apps/web/src/lib/sse-shared-stream-source.ts#createSharedSseStreamSource': 139,
  'apps/web/src/lib/user-settings-store.ts#createUserSettingsStore': 53,
  'apps/web/src/test-utils/versions-backend.contract.ts#versionsBackendContract': 95,
  'apps/web/src/pages/BrowserDocumentPage.tsx#useBrowserDocument': 491,
  'apps/web/src/pages/BrowserIndexPage.tsx#BrowserIndexPage': 153,
  // The Duplicate and Delete verbs' screen state and dialogs each live in
  // their own module beside the page, so what is here is wiring; the backend
  // seam left for `use-daemon-document-backend.ts`.
  'apps/web/src/pages/DaemonDocumentPage.tsx#useDaemonDocument': 451,
  'apps/web/src/pages/DaemonIndexPage.tsx#DaemonIndexPage': 521,
  // The inspector column, the merged header row and the markdown pane's props
  // are each a named piece, which is what keeps the page's cognitive complexity
  // under the threshold. Recorded at the measurement rather than left at an old
  // ceiling, so the next change spends headroom deliberately. The four entries
  // below are those pieces; each is a TABLE or a block of JSX rather than a
  // branch, which is the shape a size budget cannot tell from logic and a
  // complexity budget can.
  'apps/web/src/pages/DocumentPage.tsx#DocumentPageBody': 338,
  // The merged row: the top bar, its title slot, and the row actions the
  // slot carries. Long because every optional prop is spread-or-nothing
  // (`exactOptionalPropertyTypes`), and splitting it further would cut the
  // row a reader sees as one thing.
  'apps/web/src/pages/DocumentPage.tsx#DocumentHeader': 65,
  'apps/web/src/pages/document-page-inspector.tsx#DocumentInspectorSegment': 54,
  // A `Record<InspectorKind, () => ReactNode>`, one short thunk per panel.
  // The exhaustiveness is the point — a seventh kind used to compile and show
  // nothing — so the arms belong in one table, not in seven files.
  'apps/web/src/pages/document-page-inspector.tsx#inspectorPanelsFor': 146,
  // ADR-0042 decision 6's sixth state — an unlock attempt, the remembered-blob
  // read, and one more render branch — is paid for first: the three action
  // states share ONE `ReplicaActionPanel` instead of a near-identical block
  // each. The save queue, the record load, the reference seams, the editing
  // drafts and the reader's own chrome are each a named piece, which is what
  // keeps the page's cognitive complexity under the threshold; the three entries
  // below are the pieces still over the line budget, and each is one concern
  // rather than several.
  'apps/web/src/pages/ReplicaReadPage.tsx#ReplicaReadPage': 138,
  // One load: attempt, unlock, the remembered blob, and what each outcome
  // leaves on screen. The states are ADR-0042 decision 6's and they share
  // the same `setState`, so splitting them would split one transition.
  'apps/web/src/pages/ReplicaReadPage.tsx#useReplicaRecord': 70,
  'apps/web/src/pages/ReplicaReadPage.tsx#useReplicaEditing': 54,
  // The read surface: the banner, the tree and the editor. JSX, and the
  // three are what a replica IS to a reader.
  'apps/web/src/pages/ReplicaReadPage.tsx#ReplicaReader': 72,
  // Presentation only — the logic is `useTransferHandshake`. Six stages, each
  // a short branch, and the offer and the report already live in their own
  // components; the page is the switch between them.
  'apps/web/src/pages/ReceiveTransferPage.tsx#ReceiveTransferPage': 68,
  // The offer's JSX: the sender's CLAIM, the sentence saying images do not
  // travel, the target choice and the accept control. Each is a line a person
  // needs before pressing, so none can move after the press.
  'apps/web/src/pages/ReceiveTransferPage.tsx#OfferPanel': 59,
  // The Copies-on-this-device card mounts in BOTH branches, and the
  // disconnected one is where it matters most — with no daemon every copy is
  // browser-kept, so a card hidden there would hide the whole list.
  'apps/web/src/pages/SettingsPage.tsx#ConnectionsSection': 75,
  'apps/web/src/pages/SettingsPage.tsx#GeneralSection': 112,
  'apps/web/src/pages/SettingsPage.tsx#SettingsPage': 280,
  'apps/web/src/pages/SettingsPage.tsx#sectionContent': 60,
  'apps/web/src/pages/use-browser-document-controller.ts#useBrowserDocumentController': 400,
  // `duplicateDocument` is one call into lib/duplicate-daemon-document.ts,
  // shared with the index page; what is here is the list refresh and the path
  // move, the same two steps `createDocument` ends with. `deleteDocument` is the
  // delete call plus the same list refresh and path move its two siblings end
  // with. This is the backend seam out of `useDaemonDocument`: over the budget
  // as it stands, and it was over the budget inside its host too — what this
  // records is that it is NAMED: one memo deciding which connection this page
  // syncs through, the transport rule in front of it, and the auth refusal that
  // belongs to a connection rather than to a page.
  'apps/web/src/pages/use-daemon-document-backend.ts#useDaemonDocumentBackend': 91,
  'apps/web/src/pages/use-daemon-document-controller.ts#useDaemonDocumentController': 179,
  // The document-menu bundle: two hooks, the rows, the dialog and the alert row.
  // It is over the budget because it RETURNS JSX — the rows and the dialog are
  // most of its lines and splitting them out would be a component per row, which
  // is the shape this bundle exists to avoid. The JSON Canvas row is the third
  // of the three the daemon page was missing.
  'apps/web/src/pages/use-document-actions.tsx#useDocumentActions': 80,
  'apps/web/src/pwa/UpdateToast.tsx#UpdateToast': 57,
  'apps/web/src/pwa/register-sw.ts#setupSwRegistration': 76,
  'apps/web/src/pwa/register-sw.ts#setupSwRegistration.register': 58,
  'apps/web/src/test-utils/document-page.contract.tsx#describeDocumentPageContract': 86,
  'packages/canvas-render/src/layout/comments.ts#composeComments': 106,
  'packages/canvas-render/src/layout/compose-node.ts#composeTextNode': 63,
  'packages/canvas-render/src/layout/edges/edge-crossing-sweep.ts#scoreQuantizedSegmentPair': 53,
  'packages/canvas-render/src/layout/edges/spatial-edges.ts#anchorsWithoutCoincidentEnds': 69,
  'packages/canvas-render/src/layout/edges/spatial-edges.ts#assignEdgeAnchors': 52,
  'packages/canvas-render/src/layout/edges/edge-anchors.ts#computeAnchorsFor': 56,
  // The trial evaluator's three steps are named closures (applySelfCosts /
  // applyPairCosts / rescorePairsOf / rescorePairInto), each carrying the
  // invariant that would otherwise be a comment inside the loop it came from.
  // The closure is longer by those doc comments and shorter by nothing; the next
  // real shrink is lifting the score object into a module of its own, which
  // needs its eight captured caches passed as a bundle.
  'packages/canvas-render/src/layout/edges/spatial-edges.ts#createConfigScore': 308,
  'packages/canvas-render/src/layout/edges/spatial-edges.ts#optimizeAcrossRegions': 94,
  // `improveEdge` replaces the candidate loop's body and brings its
  // incumbent-wins-ties rationale with it.
  'packages/canvas-render/src/layout/edges/spatial-edges.ts#optimizeSideChoices': 102,
  'packages/canvas-render/src/layout/edges/edge-anchors.ts#patchAnchorGroups': 54,
  'packages/canvas-render/src/layout/edges/edge-router.ts#routeEdge': 75,
  'packages/canvas-render/src/layout/edges/edge-router.ts#routeOrthogonal': 139,
  // +1: the table rows take the inline typesetter by argument, since the
  // table module may not import the typesetter back.
  'packages/canvas-render/src/layout/nodes/mdast-blocks.ts#layoutBlock': 190,
  'packages/canvas-render/src/layout/nodes/mdast-blocks.ts#layoutCanvasEmbedBlock': 53,
  'packages/canvas-render/src/layout/nodes/mdast-blocks.ts#layoutListItem': 65,
  // The inline-run walker's inner steps are NAMED (emitAtomic / placeCollapsed /
  // clusterCameDown / placeSegment / emitImage / emitWikiLink / emitEmbed /
  // layoutTableCells), and each carries the rationale that would otherwise be a
  // comment mid-body. The next real shrink is moving the code-block trio and the
  // table half into sibling modules, which needs `ResolvedMdastOptions` /
  // `Cursor` extracted first or it closes a package-internal cycle.
  'packages/canvas-render/src/layout/nodes/mdast-blocks.ts#layoutPhrasing': 460,
  'packages/canvas-render/src/layout/nodes/mdast-blocks.ts#layoutPhrasing.walk': 73,
  // `clusterCameDown` and `placeSegment` replace two inline blocks and bring
  // their doc comments with them.
  'packages/canvas-render/src/layout/nodes/mdast-blocks.ts#layoutPhrasing.wrapAndPush': 87,
  'packages/canvas-render/src/layout/scale-scene.ts#scaleNode': 88,
  'packages/canvas-render/src/layout/spatial-canvas.ts#composeEdgesAndLabels': 68,
  'packages/canvas-render/src/layout/translate-scene.ts#translateNode': 65,
  'packages/canvas-render/src/quality/drawing-score.ts#scoreDrawing': 63,
  'packages/canvas-render/src/quality/facet-score.ts#scoreFacets': 67,
  'packages/canvas-render/src/references/seams.ts#referenceSeams': 73,
  'packages/canvas-render/src/svg/backend.ts#buildSvgDocumentParts': 61,
  'packages/canvas-render/src/svg/backend.ts#renderNode': 97,
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
  'packages/canvas-viewer/src/CanvasViewer.tsx#CanvasViewer': 136,
  'packages/canvas-viewer/src/font-loading.ts#loadViewerFont': 61,
  'packages/canvas-viewer/src/widget-entry.ts#applyToolResult': 58,
  'packages/canvas-viewer/src/widget-entry.ts#mountFromHost': 200,
  'packages/canvas-viewer/src/widget/comment-control.ts#createCommentControl': 118,
  'packages/codec/src/markdown/from-remark.ts#toFlow': 55,
  'packages/codec/src/markdown/from-remark.ts#toPhrasing': 55,
  'packages/codec/src/spatial/loss-table.ts#jsonCanvasLossTable': 52,
  'packages/codec/src/spatial/projection.ts#liftNode': 55,
  'packages/codec/src/test-utils/fully-populated-canvas.ts#fullyPopulatedCanvas': 92,
  'packages/daemon-client/src/replica-session-key.ts#sessionKey': 52,
  // One case each for a refused credential. A contract suite is one function by
  // design — every `it` runs against every implementation — so it grows by a
  // case, never splits.
  'packages/daemon-client/src/test-utils/document-backend-contract.ts#documentBackendContract': 118,
  'packages/daemon-client/src/test-utils/sse-stream-source-contract.ts#sseStreamSourceContract': 212,
  'packages/facet-engine/src/form.ts#normalizePicker': 53,
  'packages/facet-engine/src/registry.ts#createFacetRegistry': 211,
  'packages/facet-ui/src/catalog-picker.tsx#CatalogPicker': 213,
  'packages/facet-ui/src/catalog-popover.tsx#CatalogPopover': 144,
  'packages/facet-ui/src/derived-form.tsx#DerivedFacetForm': 171,
  'packages/facet-ui/src/derived-form.tsx#FieldInput': 90,
  'packages/facet-ui/src/facet-catalog-picker.tsx#FacetCatalogPicker': 79,
  'packages/facet-ui/src/option-group.tsx#FacetOption': 57,
  'packages/history/src/checkpoints/scheduler.ts#createCheckpointScheduler': 87,
  'packages/mcp-server/src/cli/daemon-doctor.ts#runDaemonDoctor': 73,
  'packages/mcp-server/src/cli/daemon-run.ts#runDaemonRun': 86,
  'packages/mcp-server/src/cli/daemon-status.ts#runDaemonStatus': 84,
  'packages/mcp-server/src/cli/daemon-stop.ts#runDaemonStop': 84,
  'packages/mcp-server/src/cli/daemon-support-bundle.ts#runDaemonSupportBundle': 104,
  'packages/mcp-server/src/cli/dispatcher.ts#dispatchRun': 62,
  'packages/mcp-server/src/cli/search-fetch-model.ts#runSearchFetchModel': 63,
  'packages/mcp-server/src/cli/server-doctor.ts#runServerDoctor': 59,
  'packages/mcp-server/src/cli/server-restore.ts#runServerRestore': 98,
  'packages/mcp-server/src/cli/server-run.ts#runServerRun': 137,
  'packages/mcp-server/src/cli/server-status.ts#runServerStatus': 78,
  'packages/mcp-server/src/cli/server-support-bundle.ts#runServerSupportBundle': 105,
  'packages/mcp-server/src/di/container.ts#resolveServerDeps': 94,
  // The membership gate argument and the admit wiring threaded from membershipWiring() (ADR-0041).
  'packages/mcp-server/src/server/app.ts#createApp': 138,
  'packages/mcp-server/src/server/canvas-client-notifier.ts#createCanvasClientNotifier': 81,
  'packages/mcp-server/src/server/export/headless-renderer.ts#buildExporter': 70,
  // The four workers both HTTP roots run are built and declared in
  // shared-background-work.ts; what is left here is the daemon's own, with the
  // sweeper's capped stop and the checkpoint-trigger holder there too.
  'packages/mcp-server/src/server/http-server.ts#startHttpServer': 119,
  'packages/mcp-server/src/server/index.ts#main': 81,
  'packages/mcp-server/src/server/mcp/codex-config.distribution-impl.ts#runCodexConfigSmoke': 74,
  'packages/mcp-server/src/server/mcp/document-tools.ts#registerDocumentTools': 278,
  'packages/mcp-server/src/server/mcp/mcp-e2e-checkpoint.smoke-impl.ts#runE2eCheckpointSmoke': 101,
  'packages/mcp-server/src/server/mcp/startup.smoke-impl.ts#runStartupSmoke': 67,
  'packages/mcp-server/src/server/mcp/stdio-exit.smoke-impl.ts#runStdioExitSmoke': 107,
  'packages/mcp-server/src/server/mcp/stdio-lifecycle.ts#installStdioLifecycle': 68,
  'packages/mcp-server/src/server/mcp/tarball.distribution-impl.ts#assertSemanticSearchOptIn': 81,
  'packages/mcp-server/src/server/mcp/tarball.distribution-impl.ts#runPackedTarballSmoke': 131,
  'packages/mcp-server/src/server/mcp/tool-support.ts#registerToolWithAnnotations': 102,
  'packages/mcp-server/src/server/observability/http-tracing.ts#tracingMiddleware': 51,
  'packages/mcp-server/src/server/observability/tracing.ts#initTracing': 85,
  // Threads the membership admit to the workspaces router (ADR-0041).
  'packages/mcp-server/src/server/routes/document/export-svg.ts#createDocumentSvgExportRouter': 73,
  'packages/mcp-server/src/server/routes/document/live-doc.ts#createLiveDocRouter': 60,
  // The per-document compact route is gone, and optimize-all is one fold of the
  // workspace record rather than a loop over documents.
  'packages/mcp-server/src/server/routes/document/maintenance.ts#createMaintenanceRouter': 54,
  'packages/mcp-server/src/server/routes/document/metadata.ts#createDocumentMetadataRouter': 76,
  'packages/mcp-server/src/server/routes/document/trash.ts#createTrashRouter': 68,
  'packages/mcp-server/src/server/routes/document/versions.ts#createVersionsRouter': 99,
  'packages/mcp-server/src/server/routes/document/workspace-document.ts#createWorkspaceDocumentRouter': 105,
  // The workspace list filters rows the caller is not admitted to (ADR-0041).
  // +3: the rename route is an adapter over `wbDocumentMove` now, and the
  // address translation it owes — path to id, absent to 404 — is three lines
  // the port call did not need.
  'packages/mcp-server/src/server/routes/document/workspaces.ts#createWorkspacesRouter': 266,
  'packages/mcp-server/src/server/routes/export.ts#createExportRouter': 54,
  'packages/mcp-server/src/server/routes/files.ts#createFilesRouter': 108,
  // PUT .../replica-tier and POST .../replica-key/rotate (ADR-0042 decision 1
  // and its rotation addendum) join the same router as POST .../replica-key —
  // one seam for a workspace's whole replica posture rather than a second
  // router with its own mount block.
  'packages/mcp-server/src/server/routes/replica-key.ts#createReplicaKeyRouter': 99,
  'packages/mcp-server/src/server/routes/runtime.ts#createRuntimeRouter': 67,
  // The update fan-out subscribes at construction from the deps the root hands
  // down, where a per-process memoized fallback used to resolve its own.
  'packages/mcp-server/src/server/routes/sync-sse.ts#createSyncSseRouter': 52,
  // The setter's write-side validation and the boolean answer to the lazy-row
  // hazard (ADR-0042 decision 1 addendum) both belong beside tierFor/effectiveTier
  // rather than in a second file over the same table; rotateKey (rotation
  // addendum) belongs beside keyFor/setTier for the same reason.
  'packages/mcp-server/src/server/security/workspace-replica-key-store.ts#createWorkspaceReplicaKeyStore': 78,
  // Server mode declares nothing of its own; the holder and the sweeper's
  // capped stop live in the shared wiring.
  'packages/mcp-server/src/server/server-mode-http.ts#startServerModeHttp': 103,
  // The refresh interval's in-flight write is held and awaited before the marker
  // is removed. `clearInterval` cancels the next tick and not the one already
  // running, so a straggler would recreate the marker after the `finally` deleted
  // it — 8 of 60 runs, and the same straggler raced a test's own `rm -rf` into
  // ENOTEMPTY on CI three times. The lines are a promise handle, its assignment,
  // the await, and three of comment saying why the await is there.
  'packages/mcp-server/src/server/store/backup-in-progress.ts#withBackupMarker': 56,
  'packages/mcp-server/src/server/store/backup-pass.ts#performBackup': 210,
  'packages/mcp-server/src/server/store/backup-scheduler.ts#createBackupScheduler': 207,
  'packages/mcp-server/src/server/store/backup-subprocess.ts#runBackupInSubprocess': 64,
  'packages/mcp-server/src/server/store/db/index.ts#buildDb': 62,
  // Renamed from compactDocument: the per-document address went.
  'packages/mcp-server/src/server/store/document-store.ts#compactWorkspace': 87,
  'packages/mcp-server/src/server/store/document-store.ts#saveDocument': 54,
  'packages/mcp-server/src/server/store/file-gc-sweeper.ts#createFileGcSweeper': 113,
  'packages/mcp-server/src/server/store/file-gc.ts#purgeDanglingFiles': 80,
  'packages/mcp-server/src/server/store/libsql/libsql-document-store.ts#saveCompactedSnapshot': 75,
  'packages/mcp-server/src/server/store/version-store.ts#save': 84,
  'packages/mcp-server/src/server/store/workspace-tail.ts#createWorkspaceTail': 75,
  'packages/mcp-server/src/shared/diagnostics/support-bundle-writer.ts#writeSupportBundle': 53,
  'packages/mcp-server/src/shared/test-utils/tool-surface-metrics.ts#parameterCoverage': 63,
  'packages/model/src/test-utils/zod-arbitrary.ts#walkShape': 132,
  'packages/model/src/text-anchor.ts#resolveTextAnchor': 67,
  'packages/ports/src/snapshot-helpers.ts#reassembleSnapshot': 73,
  'packages/ports/src/test-utils/blob-store-conformance.ts#describeBlobStoreConformance': 127,
  // A conformance suite is a table of cases, so each describe's size is its
  // case count. The four describes extracted from the main function keep the
  // nesting the test names report (`resolveWorkspace` and `renameWorkspace`
  // stay under `listWorkspaces`).
  'packages/ports/src/test-utils/document-index-conformance.ts#describeDocumentIndexConformance': 362,
  'packages/ports/src/test-utils/document-index-conformance.ts#describeListWorkspaces': 117,
  'packages/ports/src/test-utils/document-index-conformance.ts#describeRenameWorkspace': 96,
  'packages/ports/src/test-utils/document-index-conformance.ts#describeResolveWorkspace': 57,
  'packages/ports/src/test-utils/document-index-conformance.ts#describeSetDocumentName': 60,
  'packages/ports/src/test-utils/document-store-conformance.ts#describeDocumentStoreConformance': 639,
  // +4: the two v1 POST routes refuse a body that names the URL's own
  // workspace or document before parsing — two lines each, the refusal
  // itself being a helper above the function.
  'packages/server-core/src/create-server.ts#createServer': 223,
  'packages/server-core/src/operations/restore-version.ts#restoreToTarget': 61,
  'packages/server-core/src/test-utils/seeded-workspace.ts#seededServer': 73,
  // The tool bodies left `execute` for module functions when the write
  // lock became the operation's own: `execute` takes the lock and calls
  // them. Moved, not grown — recorded at the measurement.
  'packages/server-core/src/tools/body-edit.ts#editBody': 61,
  'packages/server-core/src/tools/canvas-edit.ts#editCanvas': 72,
  // Arrow-valued class properties: bound to the session so they can be passed as callbacks.
  'packages/server-core/src/tools/canvas-edit-session.ts#growToHold': 59,
  'packages/server-core/src/tools/canvas-edit-session.ts#patchNode': 69,
  'packages/server-core/src/tools/canvas-edit-session.ts#placeAround': 56,
  'packages/server-core/src/tools/document-crud.ts#wbDocumentCreate': 130,
  'packages/server-core/src/tools/document-search.ts#createDocumentSearchTool': 147,
  'packages/server-core/src/tools/document-search.ts#createDocumentSearchTool.execute': 135,
  'packages/server-core/src/tools/document-set.ts#createDocumentSetTool': 75,
  'packages/server-core/src/tools/facet-list.ts#createFacetListTool': 87,
  'packages/server-core/src/tools/version-restore.ts#createVersionRestoreTool': 64,
  // The one exported chunk-size constant is 18 characters longer than the local
  // `MAX_CHUNK_BYTES` it replaced, so the call sites that used to fit on one line
  // wrap. Absorbed here rather than shortened away, because the name's length is
  // what stops it reading as a cap on `chunkSnapshot` instead of a default its
  // writers share.
  'packages/workspace-index/src/document-store-workspace-docs.ts#save': 99,
  'packages/workspace-index/src/loro-workspace-document-index.ts#deleteDocument': 53,
}

/**
 * Test-file functions over the SAME budget, on the same shrink-only
 * contract, for the reason `file-size-budget.test.ts` gives its own test
 * ledger: a fixture is code someone has to read too, and a separate softer
 * budget would be a second rule nobody agreed.
 */
const TEST_FUNCTION_SIZE_GRANDFATHER: Record<string, number> = {
  'apps/web/src/components/settings/PromoteWorkspaceSection.browser.test.tsx#daemonStub': 64,
  'apps/web/src/components/spatial-editor/editor-state.property.test.ts#checkInvariants': 80,
  'apps/web/src/components/spatial-editor/editor-state.property.test.ts#run~23': 127,
  'apps/web/src/components/spatial-editor/navigation.property.test.ts#drive': 137,
  'apps/web/src/lib/browser-idb-migration.browser.test.tsx#seedV13Fixture': 79,
  'apps/web/src/lib/browser-idb-migration.browser.test.tsx#seedV18Fixture': 61,
  'apps/web/src/lib/browser-idb-migration.browser.test.tsx#seedV19Fixture': 93,
  'apps/web/src/lib/versions-backend.contract.browser.test.tsx#browserHarness': 72,
  'apps/web/src/lib/versions-backend.contract.browser.test.tsx#daemonHarness': 83,
  'packages/canvas-render/src/layout/edges/edge-crossing-sweep-narrow-phase.test.ts#referenceScore': 53,
  'packages/canvas-render/src/layout/edges/grid-route.optimality.properties.test.ts#referenceCost': 106,
  'packages/codec/src/markdown/round-trip.property.test.ts#hasNoExcludedDescendant': 88,
  // The fake daemon can refuse a credential, and the harness hands that on.
  'packages/daemon-client/src/sse-stream-hub.contract.test.ts#createHarness': 90,
  // A fake daemon whose stream, update and refusal routes are one closure over one call log.
  'packages/daemon-client/src/sse-stream-hub.test.ts#createFake': 54,
  'packages/mcp-server/src/cli/argv.differential.test.ts#oldParseDaemonRunArgs': 57,
  'packages/mcp-server/src/cli/argv.differential.test.ts#oldParseDaemonSupportBundleArgs': 54,
  'packages/mcp-server/src/cli/daemon-run-auto-open-launch.test.ts#launchDaemonInPty': 67,
  'packages/mcp-server/src/cli/server-args.differential.test.ts#oldBackup': 64,
  'packages/mcp-server/src/server/app.routes.fuzz.property.test.ts#fillPattern': 65,
  // The hand-built deps carry the daemon's lock seam, which every mutating tool
  // takes itself, and the harness hands the tools the bundled registry, since
  // the seam is required and the tools fall back to nothing.
  'packages/mcp-server/src/server/mcp/tool-call-count-quality.test.ts#harness': 80,
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

  registerSizeLedgerAssertions({
    budget: LINE_BUDGET,
    entries: MEASURED,
    ledgers: [FUNCTION_SIZE_GRANDFATHER, TEST_FUNCTION_SIZE_GRANDFATHER],
    ledgerOf: (row) => ledgerFor(row.isTest),
    readingOf: (key) => BY_KEY.get(key),
    wording: {
      titles: {
        unlisted: 'holds no un-recorded function over the budget',
        grown: 'holds no recorded function that has grown past its ceiling',
        shrunk: 'holds no entry that has shrunk to budget — delete it instead',
        missing: 'holds no entry for a function that was renamed, moved or deleted',
        headroom: 'holds no entry whose ceiling stands far above its reading — lower it',
      },
      unlisted: (row) =>
        `${row.key}: ${row.lines} lines, over the ${LINE_BUDGET}-line budget and not recorded — split it, or add it here with a reason in the diff`,
      grown: (key, lines, ceiling) =>
        `${key}: ${lines} lines, over its recorded ceiling of ${ceiling} — shrink it back, or raise the ceiling here deliberately`,
      shrunk: (key, lines) => `${key}: ${lines} lines, at or under the ${LINE_BUDGET}-line budget`,
    },
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
