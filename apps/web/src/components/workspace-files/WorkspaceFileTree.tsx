import { ChevronDown, ChevronRight, FileText, Folder, LayoutGrid } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { cn } from '../../lib/utils.js'
import type { WorkspaceDocumentEntry } from './document-entry.js'

export interface WorkspaceFileTreeProps {
  documents: readonly WorkspaceDocumentEntry[]
  onOpen: (document: WorkspaceDocumentEntry) => void
  /** The document the preview is showing, so the two agree. */
  selectedPath?: string
  /**
   * A row's icon. Capability slot, like DocumentListView's renderThumb: a
   * miniature of the document costs a fetch of its bytes, and this component
   * neither fetches nor renders — so a caller with no daemon to fetch from
   * still gets a working tree, with the kind icon below.
   */
  renderIcon?: (document: WorkspaceDocumentEntry) => ReactNode
  className?: string
}

interface TreeNode {
  /** The path segment — a folder has nothing else, and it never has a name. */
  readonly name: string
  readonly path: string
  /** Set when this exact path is a canvas; an intermediate segment that no
   *  canvas claims renders as a plain directory. */
  readonly canvas: WorkspaceDocumentEntry | null
  readonly children: TreeNode[]
}

// A document path is its full slash-joined placement: splitting on '/'
// reconstructs the tree without a second source of truth.
function buildTree(documents: readonly WorkspaceDocumentEntry[]): TreeNode[] {
  interface MutableNode {
    name: string
    path: string
    canvas: WorkspaceDocumentEntry | null
    children: Map<string, MutableNode>
  }
  const root = new Map<string, MutableNode>()

  for (const canvas of documents) {
    const segments = canvas.path.split('/')
    let level = root
    let path = ''
    for (const [i, name] of segments.entries()) {
      path = path === '' ? name : `${path}/${name}`
      let node = level.get(name)
      if (!node) {
        node = { name, path, canvas: null, children: new Map() }
        level.set(name, node)
      }
      if (i === segments.length - 1) node.canvas = canvas
      level = node.children
    }
  }

  const freeze = (nodes: Map<string, MutableNode>): TreeNode[] =>
    [...nodes.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((n) => ({ name: n.name, path: n.path, canvas: n.canvas, children: freeze(n.children) }))
  return freeze(root)
}

function TreeItem({
  node,
  onOpen,
  renderIcon,
  selectedPath,
}: {
  node: TreeNode
  onOpen: (document: WorkspaceDocumentEntry) => void
  renderIcon?: (document: WorkspaceDocumentEntry) => ReactNode
  selectedPath?: string
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
      aria-label={node.canvas?.name ?? node.name}
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
        {node.canvas ? (
          <button
            type="button"
            aria-current={node.canvas.path === selectedPath ? 'true' : undefined}
            onClick={() => node.canvas && onOpen(node.canvas)}
            className="hover:bg-accent hover:text-accent-foreground aria-[current]:bg-accent aria-[current]:text-accent-foreground flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-sm"
          >
            {/* A caller-supplied miniature when there is one; otherwise the
                kind, which the list already carries. */}
            {renderIcon?.(node.canvas) ??
              (node.canvas.kind === 'spatial' ? (
                <LayoutGrid
                  data-kind="spatial"
                  className="text-muted-foreground size-3.5 shrink-0"
                />
              ) : (
                <FileText
                  data-kind={node.canvas.kind ?? 'markdown'}
                  className="text-muted-foreground size-3.5 shrink-0"
                />
              ))}
            {/* The display name, which is what every other surface shows and
                what a `[[reference]]` resolves by. The segment is the
                fallback, not the label. */}
            <span className="truncate">{node.canvas.name ?? node.name}</span>
          </button>
        ) : (
          <span className="text-muted-foreground flex items-center gap-1.5 px-1.5 py-0.5 text-sm">
            <Folder className="size-3.5 shrink-0" />
            <span className="truncate">{node.name}</span>
          </span>
        )}
      </div>
      {hasChildren && expanded && (
        // biome-ignore lint/a11y/useSemanticElements: role="group" inside a role="tree" is the APG tree pattern; the suggested semantic elements (fieldset/optgroup) are invalid tree children
        <div role="group" className="border-border/60 ml-3 border-l pl-2">
          {node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              onOpen={onOpen}
              renderIcon={renderIcon}
              selectedPath={selectedPath}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The whole workspace in one column: folders and the documents inside them,
 * to any depth.
 *
 * This is the browser's one-column mode. Its sibling `WorkspaceFolderTree`
 * shows folders only, because there it has a contents pane beside it doing
 * the other half; here there is nothing beside it but the preview, so the
 * documents have to be reachable from the column itself.
 *
 * Nesting comes entirely from the paths the document list already carries —
 * this component never re-derives or stores tree structure of its own.
 */
export function WorkspaceFileTree({
  documents,
  onOpen,
  renderIcon,
  selectedPath,
  className,
}: WorkspaceFileTreeProps) {
  const tree = useMemo(() => buildTree(documents), [documents])

  if (tree.length === 0) {
    return (
      <p className={cn('text-muted-foreground text-sm', className)}>
        No documents in this workspace yet.
      </p>
    )
  }

  return (
    <div role="tree" aria-label="Workspace documents" className={cn('space-y-0.5', className)}>
      {tree.map((node) => (
        <TreeItem
          key={node.path}
          node={node}
          onOpen={onOpen}
          renderIcon={renderIcon}
          selectedPath={selectedPath}
        />
      ))}
    </div>
  )
}
