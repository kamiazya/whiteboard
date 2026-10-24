import { compareCodeUnit } from '@kamiazya/whiteboard-model'
import { Folder } from 'lucide-react'
import { useContext, useMemo } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { folderDisplayName } from '../../lib/folder-names.js'
import { cn } from '../../lib/utils.js'
import { ActionsButton } from './ActionsButton.js'
import { FolderActionsContext, useFolderProps } from './folder-actions.js'
import { TreeItemShell } from './TreeItemShell.js'
import { FolderNamesContext } from './use-folder-names.js'
import { useLongPressMenu } from './use-long-press.js'

export interface WorkspaceFolderTreeProps {
  documents: readonly WorkspaceDocumentEntry[]
  /** Look inside a folder — the only thing this tree does. */
  onSelectFolder: (path: string) => void
  /** The folder the pane beside this one is showing. */
  selectedFolder?: string
  className?: string
}

interface FolderNode {
  /** The path segment; what the folder is CALLED is read by path from `FolderNamesContext`. */
  readonly name: string
  /** The prefix, which is the only identity a folder has. */
  readonly path: string
  readonly children: FolderNode[]
}

/**
 * The folders of a workspace, derived entirely from document paths.
 *
 * Documents are deliberately absent. This is the sidebar of a Finder-shaped
 * browser: it answers WHERE you are, and the pane beside it answers what is
 * there. Listing documents here too made the two panes near-duplicates —
 * everything the middle pane showed was already on screen to its left.
 *
 * A path is a folder when something lives under it, whether or not a
 * document also claims that exact path: `design` is a folder while being a
 * document, and its document half is reachable in the pane that lists its
 * parent.
 */
function buildFolderTree(documents: readonly WorkspaceDocumentEntry[]): FolderNode[] {
  interface MutableNode {
    name: string
    path: string
    children: Map<string, MutableNode>
  }
  const root = new Map<string, MutableNode>()

  for (const entry of documents) {
    const segments = entry.path.split('/')
    let level = root
    let path = ''
    // The last segment names the document itself, never a folder — so a
    // document at the top level contributes no folder at all.
    for (const name of segments.slice(0, -1)) {
      path = path === '' ? name : `${path}/${name}`
      let node = level.get(name)
      if (!node) {
        node = { name, path, children: new Map() }
        level.set(name, node)
      }
      level = node.children
    }
  }

  const freeze = (nodes: Map<string, MutableNode>): FolderNode[] =>
    [...nodes.values()]
      .sort((a, b) => compareCodeUnit(a.name, b.name))
      .map((n) => ({ name: n.name, path: n.path, children: freeze(n.children) }))
  return freeze(root)
}

/** A folder's own row: the button that opens it, and its actions on a touch screen. */
function FolderRowButton({
  node,
  shown,
  onSelectFolder,
  selectedFolder,
}: {
  node: FolderNode
  shown: string
  onSelectFolder: (path: string) => void
  selectedFolder?: string
}) {
  const folderProps = useFolderProps(node.path)
  const actions = useContext(FolderActionsContext)
  return (
    <>
      <button
        type="button"
        data-folder-path={node.path}
        aria-label={`Open folder ${shown}`}
        aria-current={node.path === selectedFolder ? 'true' : undefined}
        onClick={() => onSelectFolder(node.path)}
        {...folderProps}
        className="data-[dropping]:ring-ring data-[dropping]:ring-2 hover:bg-accent hover:text-accent-foreground aria-[current]:bg-accent aria-[current]:text-accent-foreground flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-sm"
      >
        <Folder className="text-muted-foreground size-3.5 shrink-0" />
        <span className="truncate">{shown}</span>
      </button>
      {actions !== undefined && (
        <ActionsButton name={shown} onOpen={(x, y) => actions.openFolderMenu(node.path, x, y)} />
      )}
    </>
  )
}

function FolderItem({
  node,
  onSelectFolder,
  selectedFolder,
}: {
  node: FolderNode
  onSelectFolder: (path: string) => void
  selectedFolder?: string
}) {
  const shown = folderDisplayName(node.path, useContext(FolderNamesContext))
  return (
    <TreeItemShell
      name={shown}
      label={shown}
      hasChildren={node.children.length > 0}
      row={
        <FolderRowButton
          node={node}
          shown={shown}
          onSelectFolder={onSelectFolder}
          selectedFolder={selectedFolder}
        />
      }
    >
      {node.children.map((child) => (
        <FolderItem
          key={child.path}
          node={child}
          onSelectFolder={onSelectFolder}
          selectedFolder={selectedFolder}
        />
      ))}
    </TreeItemShell>
  )
}

function RootFolderItem({
  selectedFolder,
  onSelectFolder,
}: {
  selectedFolder?: string
  onSelectFolder: (path: string) => void
}) {
  const rootProps = useFolderProps('')
  const actions = useContext(FolderActionsContext)
  return (
    // The root is a destination like any other folder, and the only one
    // reachable when every document sits at the top level.
    <div role="treeitem" tabIndex={-1} aria-label="Workspace">
      <div className="flex items-center gap-1">
        <span className="w-[1.125rem]" aria-hidden="true" />
        <button
          type="button"
          data-folder-path=""
          aria-label="Open folder Workspace"
          aria-current={selectedFolder === '' ? 'true' : undefined}
          onClick={() => onSelectFolder('')}
          {...rootProps}
          className="data-[dropping]:ring-ring data-[dropping]:ring-2 hover:bg-accent hover:text-accent-foreground aria-[current]:bg-accent aria-[current]:text-accent-foreground flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-sm"
        >
          <Folder className="text-muted-foreground size-3.5 shrink-0" />
          <span className="truncate">Workspace</span>
        </button>
        {actions !== undefined && (
          <ActionsButton name="Workspace" onOpen={(x, y) => actions.openFolderMenu('', x, y)} />
        )}
      </div>
    </div>
  )
}

export function WorkspaceFolderTree({
  documents,
  onSelectFolder,
  selectedFolder,
  className,
}: WorkspaceFolderTreeProps) {
  const tree = useMemo(() => buildFolderTree(documents), [documents])
  const longPress = useLongPressMenu(undefined)

  return (
    <div
      role="tree"
      aria-label="Workspace folders"
      {...longPress}
      className={cn('space-y-0.5', className)}
    >
      <RootFolderItem selectedFolder={selectedFolder} onSelectFolder={onSelectFolder} />
      {tree.map((node) => (
        <FolderItem
          key={node.path}
          node={node}
          onSelectFolder={onSelectFolder}
          selectedFolder={selectedFolder}
        />
      ))}
    </div>
  )
}
