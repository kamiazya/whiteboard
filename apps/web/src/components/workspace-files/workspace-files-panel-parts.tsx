import {
  CheckCircle2,
  Columns2,
  CopyPlus,
  ExternalLink,
  Eye,
  List,
  Pencil,
  Pin,
  PinOff,
  Search,
  Trash2,
} from 'lucide-react'
import type { ComponentProps } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.js'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import type { WorkspaceFilesSource } from '../../lib/files-source.js'
import type { ContextMenu } from '../spatial-editor/ContextMenu.js'
import { DocumentPreview } from './DocumentPreview.js'
import { DocumentThumbnail } from './DocumentThumbnail.js'
import { FolderBreadcrumb } from './FolderBreadcrumb.js'
import { FolderContentsList } from './FolderContentsList.js'
import { NewDocumentMenu } from './NewDocumentMenu.js'
import { SearchResults } from './SearchResults.js'
import { searchDocuments, withNameMatches } from './search-documents.js'
import type { useDebouncedDocumentSearch } from './use-debounced-document-search.js'
import type { useWriteOutcome } from './use-write-outcome.js'
import type { WorkspaceFilesPanelProps } from './WorkspaceFilesPanel.js'
import { WorkspaceFolderTree } from './WorkspaceFolderTree.js'

/**
 * How a write that landed is named once its list refresh failed. The verb is
 * the message: it says what is now TRUE despite the stale list, which is what
 * stops the person pressing again.
 */
const REFRESH_FAILURE_VERB: Record<'created' | 'pinned' | 'unpinned', string> = {
  created: 'Created',
  pinned: 'Pinned',
  unpinned: 'Unpinned',
}

/**
 * What the results list is given.
 *
 * Two answers, and the difference is where the search HAPPENED. A `#tag`
 * query is a FILTER over what is already loaded and never leaves the client;
 * so is the fallback while content search is unreachable or still in flight,
 * because the names and paths already in hand are a real answer rather than
 * a blank pane. Everything else is the source's own hits, widened with the
 * documents whose NAME matches — a content index does not rank a name.
 */
export function searchResultRows({
  activeTag,
  hits,
  documents,
  query,
}: {
  activeTag: string | null
  hits: ReturnType<typeof useDebouncedDocumentSearch>['hits']
  documents: readonly WorkspaceDocumentEntry[]
  query: string
}): ComponentProps<typeof SearchResults>['results'] {
  if (activeTag !== null || hits === null) {
    return searchDocuments(documents, query).map((document) => ({ document }))
  }
  return withNameMatches(
    hits.map((hit) => ({
      document: hit.document,
      contexts: hit.contexts,
      ...(hit.lexicalRank === undefined ? {} : { lexicalRank: hit.lexicalRank }),
      ...(hit.semanticRank === undefined ? {} : { semanticRank: hit.semanticRank }),
    })),
    documents,
    query,
  )
}

/**
 * What the last write refused to do, if anything. Three separate `role=alert`
 * paragraphs rather than one, because each names a different subject and a
 * reader arriving at the second must not have to have read the first.
 *
 * The stale-list one is the odd one: the write SUCCEEDED and only the list
 * behind it did not refresh, which is why it says what was done before
 * saying what could not be shown.
 */
export function PanelRefusals({ outcome }: { outcome: ReturnType<typeof useWriteOutcome> }) {
  return (
    <>
      {outcome.createRefusal !== null && (
        <p role="alert" className="text-destructive text-sm">
          Could not create a {outcome.createRefusal.kind} document here.
        </p>
      )}

      {outcome.pinRefusal !== null && (
        <p role="alert" className="text-destructive text-sm">
          Could not {outcome.pinRefusal.pinning ? 'pin' : 'unpin'} “{outcome.pinRefusal.path}”.{' '}
          {outcome.pinRefusal.reason}
        </p>
      )}

      {outcome.staleList !== null && (
        <p role="alert" className="text-destructive text-sm">
          {REFRESH_FAILURE_VERB[outcome.staleList.action]} “{outcome.staleList.path}”, but this list
          could not be refreshed. Reload to see it.
        </p>
      )}
    </>
  )
}

/**
 * The object pane beside the columns. Each verb is spread-or-nothing so the
 * pane offers only what the HOST can actually do — a missing handler means
 * the affordance is absent rather than inert, which is the difference
 * between "this build cannot" and "this one failed".
 */
export function PanelPreview({
  selected,
  loadRender,
  onOpenDocument,
  onRename,
  onDuplicateDocument,
  onRequestDelete,
}: {
  selected: WorkspaceDocumentEntry | null
  loadRender: ComponentProps<typeof DocumentPreview>['loadRender']
  onOpenDocument: WorkspaceFilesPanelProps['onOpenDocument']
  onRename: (entry: WorkspaceDocumentEntry) => void
  onDuplicateDocument: WorkspaceFilesPanelProps['onDuplicateDocument']
  onRequestDelete: WorkspaceFilesPanelProps['onRequestDelete']
}) {
  return (
    <DocumentPreview
      document={selected}
      loadRender={loadRender}
      {...(onOpenDocument === undefined
        ? {}
        : { onOpen: (entry: WorkspaceDocumentEntry) => onOpenDocument(entry.path) })}
      onRename={onRename}
      {...(onDuplicateDocument === undefined
        ? {}
        : { onDuplicate: (entry: WorkspaceDocumentEntry) => onDuplicateDocument(entry.path) })}
      {...(onRequestDelete === undefined
        ? {}
        : {
            onDelete: (entry: WorkspaceDocumentEntry) =>
              onRequestDelete(entry.path, entry.name ?? entry.path, entry.kind),
          })}
      className="h-full"
    />
  )
}

/**
 * The row above the columns: where you are, what you are looking for, and
 * the two things you can change about the view.
 *
 * The trail belongs to whatever NARROWS the view, which is why it has two
 * conditions rather than one. In one-column mode nothing narrows — the tree
 * already shows every level at once — and while searching the results are
 * from everywhere, so a trail would name a folder the list is not confined
 * to.
 */
export function PanelToolbar({
  columns,
  query,
  folder,
  selectFolder,
  changeQuery,
  creating,
  workspace,
  derivedNewPath,
  outcome,
  createHere,
  chooseColumns,
}: {
  columns: 'one' | 'two'
  query: string
  folder: string
  selectFolder: (folder: string) => void
  changeQuery: (next: string) => void
  creating: boolean
  workspace: WorkspaceFilesPanelProps['workspace']
  derivedNewPath: string
  outcome: ReturnType<typeof useWriteOutcome>
  createHere: ComponentProps<typeof NewDocumentMenu>['onCreate']
  chooseColumns: (next: 'one' | 'two') => void
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        {/* The trail belongs to whatever narrows the view. In one-column
          mode nothing does — the tree already shows every level at once —
          and while searching the results are from everywhere, so a trail
          would name a folder the list is not confined to. */}
        {columns === 'two' && query.trim() === '' && (
          <FolderBreadcrumb folder={folder} onSelect={selectFolder} />
        )}
      </div>
      <div className="relative shrink-0">
        <Search
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2"
        />
        <input
          type="search"
          aria-label="Search documents"
          placeholder="Search"
          value={query}
          onChange={(event) => changeQuery(event.target.value)}
          className="w-36 rounded border py-1 pl-7 pr-2 text-xs sm:w-48"
        />
      </div>
      <NewDocumentMenu
        disabled={creating}
        workspace={workspace}
        defaultPath={derivedNewPath}
        createError={outcome.createRefusal?.reason ?? null}
        onCreate={createHere}
        onDismiss={outcome.dismissCreateRefusal}
      />
      <fieldset className="flex shrink-0 items-center gap-0.5 rounded border p-0.5">
        <legend className="sr-only">Column layout</legend>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="One column"
              aria-pressed={columns === 'one'}
              onClick={() => chooseColumns('one')}
              className="text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground rounded p-1"
            >
              <List className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>One column</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Two columns"
              aria-pressed={columns === 'two'}
              onClick={() => chooseColumns('two')}
              className="text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground rounded p-1"
            >
              <Columns2 className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Two columns</TooltipContent>
        </Tooltip>
      </fieldset>
    </div>
  )
}

/**
 * What a card's own menu offers for one document. Every entry is
 * spread-or-nothing on the HOST's ability to do it, so a build that cannot
 * duplicate shows no Duplicate row rather than an inert one — the difference
 * between "not here" and "broken".
 *
 * Preview is the exception and depends on the POINTER rather than on a
 * handler: where a tap opens, the object pane cannot be filled by selecting,
 * so this menu is the only way to look at a document without leaving.
 */
export function cardMenuItemsFor(
  entry: WorkspaceDocumentEntry,
  {
    tapOpens,
    source,
    onOpenDocument,
    onDuplicateDocument,
    onRequestDelete,
    onRequestDeleteMany,
    setPeek,
    setSelected,
    setSelection,
    togglePinned,
    openRename,
  }: {
    tapOpens: boolean
    source: WorkspaceFilesSource
    onOpenDocument: WorkspaceFilesPanelProps['onOpenDocument']
    onDuplicateDocument: WorkspaceFilesPanelProps['onDuplicateDocument']
    onRequestDelete: WorkspaceFilesPanelProps['onRequestDelete']
    onRequestDeleteMany: WorkspaceFilesPanelProps['onRequestDeleteMany']
    setPeek: (entry: WorkspaceDocumentEntry) => void
    setSelected: (entry: WorkspaceDocumentEntry) => void
    setSelection: (next: ReadonlySet<string>) => void
    togglePinned: (entry: WorkspaceDocumentEntry) => Promise<void> | void
    openRename: (entry: WorkspaceDocumentEntry) => void
  },
): ComponentProps<typeof ContextMenu>['items'] {
  return [
    ...(onOpenDocument === undefined
      ? []
      : [
          {
            label: 'Open',
            icon: <ExternalLink />,
            onSelect: () => onOpenDocument(entry.path),
          },
        ]),
    ...(tapOpens
      ? [
          {
            label: 'Preview',
            icon: <Eye />,
            onSelect: () => setPeek(entry),
          },
        ]
      : []),
    ...(onDuplicateDocument === undefined
      ? []
      : [
          {
            label: 'Duplicate',
            icon: <CopyPlus />,
            onSelect: () => onDuplicateDocument(entry.path),
          },
        ]),
    ...(source.setPinned === undefined
      ? []
      : [
          {
            label: entry.pinOrder === undefined ? 'Pin' : 'Unpin',
            icon: entry.pinOrder === undefined ? <Pin /> : <PinOff />,
            onSelect: () => void togglePinned(entry),
          },
        ]),
    ...(onRequestDeleteMany === undefined
      ? []
      : [
          {
            label: 'Select',
            icon: <CheckCircle2 />,
            onSelect: () => setSelection(new Set([entry.path])),
          },
        ]),
    {
      label: 'Rename…',
      icon: <Pencil />,
      onSelect: () => {
        setSelected(entry)
        openRename(entry)
      },
    },
    ...(onRequestDelete === undefined
      ? []
      : [
          {
            label: 'Delete',
            icon: <Trash2 />,
            danger: true,
            onSelect: () => onRequestDelete(entry.path, entry.name ?? entry.path, entry.kind),
          },
        ]),
  ]
}

/**
 * Which of four things the column area is showing, and the documents that
 * view has — named rather than left implicit in a chain of tests about
 * different subjects.
 *
 * It was `documents === null ? … : query.trim() !== '' ? … : columns ===
 * 'one' ? … : …`, and a reader had to derive the last arm from the absence
 * of the other three. The chain also carried a NARROWING that its shape hid:
 * every arm after the first runs only when `documents` is non-null, and
 * nothing said so except the order. Here the union says it, so the three
 * loaded views get the array and the loading view cannot ask for one.
 */
export type ColumnView =
  | { kind: 'loading' }
  | { kind: 'searching'; documents: readonly WorkspaceDocumentEntry[] }
  | { kind: 'browseOne'; documents: readonly WorkspaceDocumentEntry[] }
  | { kind: 'browseTwo'; documents: readonly WorkspaceDocumentEntry[] }

export function columnViewOf(
  documents: readonly WorkspaceDocumentEntry[] | null,
  query: string,
  columns: 'one' | 'two',
): ColumnView {
  if (documents === null) return { kind: 'loading' }
  if (query.trim() !== '') return { kind: 'searching', documents }
  return columns === 'one' ? { kind: 'browseOne', documents } : { kind: 'browseTwo', documents }
}

/**
 * The folder tree beside the folder's own contents. Below `md` the folder
 * column goes: the breadcrumb already walks the same hierarchy, and three
 * columns in a phone's width leaves none of them readable.
 *
 * What a press DOES is `contentsOpenTarget` — four answers that a chain of
 * ternaries used to state in the middle of a prop.
 */
export function BrowseTwoColumns({
  documents,
  folder,
  selectFolder,
  selectedPath,
  selection,
  changed,
  tapOpens,
  onOpenDocument,
  openEntry,
  setSelected,
  toggleSelected,
  openCardMenu,
  loadRender,
}: {
  documents: readonly WorkspaceDocumentEntry[]
  folder: string
  selectFolder: (path: string) => void
  selectedPath: string | undefined
  selection: ReadonlySet<string> | null
  changed: ReadonlySet<string> | undefined
  tapOpens: boolean
  onOpenDocument: WorkspaceFilesPanelProps['onOpenDocument']
  openEntry: (entry: WorkspaceDocumentEntry) => void
  setSelected: (entry: WorkspaceDocumentEntry) => void
  toggleSelected: (entry: WorkspaceDocumentEntry) => void
  openCardMenu: (entry: WorkspaceDocumentEntry, clientX: number, clientY: number) => void
  loadRender: ComponentProps<typeof DocumentThumbnail>['loadRender']
}) {
  /**
   * A press in the contents list, in the order the four answers rank: a
   * folder always navigates; a live selection always toggles rather than
   * opens, or a selecting person could not reach a second document; where a
   * tap opens there is no object pane to fill; otherwise it selects.
   */
  const openTarget = (
    target: ComponentProps<typeof FolderContentsList>['onOpen'] extends (t: infer T) => void
      ? T
      : never,
  ) => {
    if (target.kind === 'folder') return selectFolder(target.path)
    if (selection !== null) return toggleSelected(target.document)
    return tapOpens ? openEntry(target.document) : setSelected(target.document)
  }

  return (
    <>
      <div className="hidden w-56 shrink-0 overflow-y-auto border-r pr-3 md:block">
        <WorkspaceFolderTree
          documents={documents}
          onSelectFolder={selectFolder}
          selectedFolder={folder}
        />
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto md:border-r md:pr-3">
        <div data-testid="folder-contents">
          <FolderContentsList
            documents={documents}
            folder={folder}
            selectedPath={selectedPath}
            onOpen={openTarget}
            {...(selection === null ? { selection: undefined } : { selection })}
            {...(changed === undefined ? {} : { changed })}
            {...(onOpenDocument === undefined || selection !== null
              ? {}
              : { onActivateDocument: openEntry })}
            onDocumentContextMenu={openCardMenu}
            renderThumbnail={(entry) => (
              <DocumentThumbnail
                key={entry.documentId}
                document={entry}
                loadRender={loadRender}
                className="size-full"
              />
            )}
          />
        </div>
      </div>
    </>
  )
}

/**
 * The results of a search, in place of the columns. They come from
 * everywhere, so neither the folder tree nor the folder's own contents
 * describes them: one flat list, in both column modes — a search that
 * behaved differently per mode would be two features wearing one box.
 */
export function SearchColumn({
  documents,
  query,
  activeTag,
  hits,
  searchDegraded,
  selectedPath,
  tapOpens,
  onOpenDocument,
  openEntry,
  setSelected,
  openCardMenu,
  loadRender,
}: {
  documents: readonly WorkspaceDocumentEntry[]
  query: string
  activeTag: string | null
  hits: ReturnType<typeof useDebouncedDocumentSearch>['hits']
  searchDegraded: boolean
  selectedPath: string | undefined
  tapOpens: boolean
  onOpenDocument: WorkspaceFilesPanelProps['onOpenDocument']
  openEntry: (entry: WorkspaceDocumentEntry) => void
  setSelected: (entry: WorkspaceDocumentEntry) => void
  openCardMenu: (entry: WorkspaceDocumentEntry, clientX: number, clientY: number) => void
  loadRender: ComponentProps<typeof DocumentThumbnail>['loadRender']
}) {
  return (
    // Results come from everywhere, so neither the folder tree nor the
    // folder's own contents describes them. One flat list, in both
    // column modes — a search that behaved differently per mode would
    // be two features wearing one box.
    <div className="min-w-0 flex-1 overflow-y-auto md:border-r md:pr-3">
      <div data-testid="search-results">
        {/* Always mounted, text swapped: a polite live region added to
            the DOM already carrying its message is announced
            inconsistently (see polite-live-region.test.ts). */}
        <p
          role="status"
          className={searchDegraded ? 'text-muted-foreground mb-1 text-xs' : 'sr-only'}
        >
          {searchDegraded
            ? 'Searching names and paths only — this workspace’s content search is unavailable.'
            : ''}
        </p>
        <SearchResults
          {...(onOpenDocument === undefined ? {} : { onActivate: openEntry })}
          // A `#tag` query is a FILTER over what is loaded (#975's
          // contract), not a content search — it never leaves the
          // client. Everything else asks the source.
          results={searchResultRows({
            activeTag,
            hits,
            documents: documents,
            query,
          })}
          query={query}
          searchedContents={activeTag === null && hits !== null}
          selectedPath={selectedPath}
          onSelect={tapOpens ? openEntry : setSelected}
          onDocumentContextMenu={openCardMenu}
          renderThumbnail={(entry) => (
            <DocumentThumbnail
              key={entry.documentId}
              document={entry}
              loadRender={loadRender}
              className="size-full"
            />
          )}
        />
      </div>
    </div>
  )
}
