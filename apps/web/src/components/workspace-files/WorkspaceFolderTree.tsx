import { ChevronDown, ChevronRight, Folder } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '../../lib/utils.js'
import type { WorkspaceDocumentEntry } from './document-entry.js'

export interface WorkspaceFolderTreeProps {
  documents: readonly WorkspaceDocumentEntry[]
  /** Look inside a folder — the only thing this tree does. */
  onSelectFolder: (path: string) => void
  /** The folder the pane beside this one is showing. */
  selectedFolder?: string
  className?: string
}

interface FolderNode {
  /** The path segment — a folder has no name of its own. */
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
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((n) => ({ name: n.name, path: n.path, children: freeze(n.children) }))
  return freeze(root)
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
  const [expanded, setExpanded] = useState(true)
  const hasChildren = node.children.length > 0

  return (
    // Generic containers carry the ARIA tree roles (APG tree pattern):
    // biome's a11y rules reject interactive roles on semantic ul/li.
    // tabIndex satisfies useFocusableInteractive; actual keyboard operation
    // happens through the nested native buttons, which are tabbable.
    <div
      role="treeitem"
      tabIndex={-1}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-label={node.name}
    >
      <div className="flex items-center gap-1">
        {hasChildren ? (
          <button
            type="button"
            data-testid={`tree-toggle-${node.path.replaceAll('/', '-')}`}
            aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            onClick={() => setExpanded((prev) => !prev)}
            className="text-muted-foreground hover:text-foreground rounded p-0.5"
          >
            {expanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        ) : (
          <span className="w-[1.125rem]" aria-hidden="true" />
        )}
        <button
          type="button"
          aria-label={`Open folder ${node.name}`}
          aria-current={node.path === selectedFolder ? 'true' : undefined}
          onClick={() => onSelectFolder(node.path)}
          className="hover:bg-accent hover:text-accent-foreground aria-[current]:bg-accent aria-[current]:text-accent-foreground flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-sm"
        >
          <Folder className="text-muted-foreground size-3.5 shrink-0" />
          <span className="truncate">{node.name}</span>
        </button>
      </div>
      {hasChildren && expanded && (
        // biome-ignore lint/a11y/useSemanticElements: role="group" inside a role="tree" is the APG tree pattern; the suggested semantic elements (fieldset/optgroup) are invalid tree children
        <div role="group" className="border-border/60 ml-3 border-l pl-2">
          {node.children.map((child) => (
            <FolderItem
              key={child.path}
              node={child}
              onSelectFolder={onSelectFolder}
              selectedFolder={selectedFolder}
            />
          ))}
        </div>
      )}
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

  return (
    <div role="tree" aria-label="Workspace folders" className={cn('space-y-0.5', className)}>
      {/* The root is a destination like any other folder, and the only one
          reachable when every document sits at the top level. */}
      <div role="treeitem" tabIndex={-1} aria-label="Workspace">
        <div className="flex items-center gap-1">
          <span className="w-[1.125rem]" aria-hidden="true" />
          <button
            type="button"
            aria-label="Open folder Workspace"
            aria-current={selectedFolder === '' ? 'true' : undefined}
            onClick={() => onSelectFolder('')}
            className="hover:bg-accent hover:text-accent-foreground aria-[current]:bg-accent aria-[current]:text-accent-foreground flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-sm"
          >
            <Folder className="text-muted-foreground size-3.5 shrink-0" />
            <span className="truncate">Workspace</span>
          </button>
        </div>
      </div>
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
