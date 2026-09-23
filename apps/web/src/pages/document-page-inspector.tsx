import { type ReactNode, useCallback, useState } from 'react'
import { CommentsRailAside } from '../components/annotations/CommentsRailChrome.js'
import { ConnectionsPanel } from '../components/connections/ConnectionsPanel.js'
import { InspectorPanel } from '../components/document-editor/InspectorPanel.js'
import { InspectorSegment } from '../components/document-editor/InspectorSegment.js'
import { DocumentFacetsEditor } from '../components/document-properties/DocumentProperties.js'
import { ProposalsPanel } from '../components/proposals/ProposalsPanel.js'
import { CanvasDisplaySettings } from '../components/spatial-editor/CanvasDisplaySettings.js'
import type { VersionPreviewSession } from '../components/VersionTimeline'
import type { SaveVersionOutcome } from '../components/workspace-top-bar/BookmarkAction.js'
import { BookmarkAction } from '../components/workspace-top-bar/BookmarkAction.js'
import { DocumentMenu } from '../components/workspace-top-bar/DocumentMenu.js'
import type { useSceneExport } from '../components/workspace-top-bar/useSceneExport.js'
import { VersionPanel } from '../components/workspace-top-bar/VersionPanel.js'
import type { useCommentsRail } from '../hooks/use-comments-rail.js'
import type { InspectorKind } from '../lib/inspector.js'
import { openProposals } from '../lib/open-proposals.js'
import type { SpatialEditorHandle } from '../lib/spatial/editor-handle.js'
import type { DocumentPageModel } from './document-page-model.js'

/**
 * The inspector members this document offers. What a KIND decides is WHICH
 * members exist; never their order, which is why a canvas and a note read the
 * same.
 */
export function DocumentInspectorSegment({
  inspector,
  toggleInspector,
  model,
  documentKind,
  openThreadCount,
  proposals,
  versionsEnabled,
}: {
  inspector: InspectorKind | null
  toggleInspector: (kind: InspectorKind) => void
  model: DocumentPageModel
  documentKind: DocumentPageModel['documentKind']
  openThreadCount: number
  proposals: DocumentPageModel['threads']['proposals']
  versionsEnabled: boolean
}) {
  return (
    <InspectorSegment
      open={inspector}
      onToggle={toggleInspector}
      tabs={{
        // Facets are OKF frontmatter, so only a markdown document has any
        // (ADR-0009 decision 3); the keeper answers none for a spatial one.
        ...(model.properties.facets === undefined ? {} : { properties: {} }),
        // The spatial document's own attributes, in the place the markdown
        // document's frontmatter takes: a canvas has no frontmatter and a
        // note has no canvas, so the two never appear together and the
        // segment reads the same length either way.
        //
        // No `preview === null` guard, and that is checked rather than
        // assumed: this panel writes the LIVE document, so drawing it over
        // a past state would be a write against a canvas nobody is looking
        // at — but the state cannot arise. `WorkspaceTopBar` replaces the
        // whole row while previewing, so no opener renders, and `preview`
        // is set only by `VersionPanel`, which needs the slot to be holding
        // `history`. Pinned in versions.browser.test.tsx.
        ...(documentKind === 'spatial' ? { display: {} } : {}),
        comments: { count: openThreadCount },
        // Always offered, and pressable at nought (user decision,
        // 2026-09-07): a document with no proposals is a fact worth being
        // able to check, and a member that comes and goes is a control that
        // moves under the finger reaching for its neighbour.
        proposals: { count: openProposals(proposals).length },
        // `null` until the backlinks fetch answers: the member waits rather
        // than claiming zero, which is what the chip did before it moved.
        ...(model.connections === undefined
          ? {}
          : { connections: { count: model.connections.backlinks?.length ?? null } }),
        ...(versionsEnabled ? { history: {} } : {}),
      }}
    />
  )
}

/**
 * The document row's controls: inspect on the left of the divider, act on the
 * right. Before the divider the act menu sat BETWEEN two inspect toggles; its
 * margin is what makes the segment read as one group now that the segment
 * draws no box.
 */
export function DocumentRowActions({
  inspectorSegment,
  model,
  exportError,
  onExport,
  onBookmark,
  versionsEnabled,
}: {
  inspectorSegment: ReactNode
  model: DocumentPageModel
  exportError: string | null | undefined
  onExport: (
    format: Parameters<ReturnType<typeof useSceneExport>['handleExport']>[0],
  ) => void | Promise<void>
  onBookmark: () => void
  versionsEnabled: boolean
}) {
  return (
    <>
      {inspectorSegment}
      {/* The one divider in the row: inspect on the left of it, act on the
          right. Before this the act menu sat BETWEEN two inspect toggles.
          Its margin is what makes the segment read as one group now that
          the segment draws no box: 2px between its members, 6px out to
          here, so proximity does the work the outline used to. */}
      <span aria-hidden="true" className="bg-border mx-1.5 h-4 w-px shrink-0" />
      {model.slots.rowAlerts}
      {exportError && (
        <div role="alert" aria-live="assertive" className="text-destructive text-xs">
          {exportError}
        </div>
      )}
      <DocumentMenu
        onExport={(format) => void onExport(format)}
        {...(versionsEnabled ? { onBookmark } : {})}
        {...(model.slots.menuTriggerRef === undefined
          ? {}
          : { triggerRef: model.slots.menuTriggerRef })}
      >
        {model.slots.menuItems}
      </DocumentMenu>
      {model.slots.afterMenu}
    </>
  )
}

/**
 * Which panel the one inspector slot draws, per member. A function of the
 * page's state rather than a literal inside the body: each arm closes over a
 * different part of the model, and reading which is which was the knot.
 */
export function inspectorPanelsFor(deps: {
  versions: DocumentPageModel['versions']
  sync: DocumentPageModel['sync']
  setPreview: (session: VersionPreviewSession | null) => void
  versionRefreshSignal: number
  setInspector: (kind: InspectorKind | null) => void
  savingVersion: boolean
  saveVersionOutcome: SaveVersionOutcome
  bookmarkArmed: number
  saveVersionFromPanel: (label: string) => Promise<void>
  commentsRail: ReturnType<typeof useCommentsRail>
  threads: DocumentPageModel['threads']
  preview: VersionPreviewSession | null
  documentKind: DocumentPageModel['documentKind']
  model: DocumentPageModel
  spatialHandle: { current: SpatialEditorHandle | null }
}): Record<InspectorKind, () => ReactNode> {
  const {
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
  } = deps
  return {
    history: () =>
      versions.enabled ? (
        <VersionPanel
          workspaceId={versions.workspaceId}
          path={versions.path}
          onRestored={sync.clearLocalUndo}
          onPreview={setPreview}
          refreshSignal={versionRefreshSignal}
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
      ) : undefined,
    comments: () => (
      /* The annotation layer's document-level surface (ADR-0026
         decision 5) sits BESIDE the editor rather than inside it,
         because one panel serves both document kinds and a markdown
         document has no canvas chrome to host one. Its opener lives in
         the document actions row, in flow.

         Not writable while a past state is on screen: the editor is
         replaced by VersionPreview but this rail is not, and its
         writes go to the LIVE document. */
      <CommentsRailAside
        rail={commentsRail}
        threads={threads.annotations}
        writable={preview === null}
      />
    ),
    proposals: () => (
      <InspectorPanel kind="proposals" onClose={() => setInspector(null)}>
        <ProposalsPanel
          proposals={threads.proposals}
          // Two ways to have no viewport to move, and the panel wants
          // the same answer for both. A markdown body draws its
          // passages where they are already; and while a past state is
          // on screen the live editor is UNMOUNTED (`preview ?
          // VersionPreview : DocumentEditorSurface` below), so the
          // handle is null and a row would be a button that does
          // nothing. The index still counts either way — it just has
          // nowhere to send you, which the panel draws as a row that is
          // not a button rather than a dead one.
          {...(documentKind === 'spatial' && preview === null
            ? { onOpen: (id: string) => spatialHandle.current?.openProposal(id) }
            : {})}
        />
      </InspectorPanel>
    ),
    connections: () =>
      model.connections !== undefined && model.connections.backlinks !== null ? (
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
      ) : undefined,
    properties: () =>
      model.properties.facets !== undefined ? (
        <InspectorPanel kind="properties" onClose={() => setInspector(null)}>
          <DocumentFacetsEditor
            facets={model.properties.facets}
            {...(model.properties.onFacetsChange === undefined
              ? {}
              : { onChange: model.properties.onFacetsChange })}
            {...(model.tags === undefined
              ? {}
              : { tagSuggestions: model.tags.inUse, tagLibrary: model.tags.library })}
          />
        </InspectorPanel>
      ) : undefined,
    display: () =>
      documentKind === 'spatial' ? (
        /* Canvas-wide display settings, in the slot the other panels
         share. They were a popover off the ⋯ kebab until this, which
         on a phone had no way out at all: Radix dismisses a popover on
         an outside click or Escape, and at 424px of panel against a
         390px screen there was neither a keyboard nor much outside.
         Here the sheet brings its own close, and opening any other
         panel takes the slot back. */
        <InspectorPanel kind="display" onClose={() => setInspector(null)}>
          <div className="p-3">
            <CanvasDisplaySettings
              canvas={sync.canvas}
              onChange={sync.onChange}
              {...(model.tags === undefined
                ? {}
                : { tagSuggestions: model.tags.inUse, tagLibrary: model.tags.library })}
            />
          </div>
        </InspectorPanel>
      ) : undefined,
  }
}

/**
 * The one inspector slot beside the editor: the document's properties, its
 * conversations, the documents linking to it, or its history — never two at
 * once. Which panel is open is how the reader LOOKS rather than what at, so
 * it survives a document switch: everything a panel says is document-scoped
 * and reset by the hook that owns it.
 */
export function useInspectorSlot() {
  const [inspector, setInspector] = useState<InspectorKind | null>(null)
  const toggleInspector = (kind: InspectorKind) =>
    setInspector((open) => (open === kind ? null : kind))
  const setCommentsOpen = useCallback((open: boolean) => setInspector(open ? 'comments' : null), [])
  return { inspector, setInspector, toggleInspector, setCommentsOpen }
}
