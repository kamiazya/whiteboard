import { ChevronDown, ChevronRight, FileText, Folder } from 'lucide-react'
import { useMemo, useState } from 'react'
import { cn } from '../../lib/utils.js'

export interface WorkspaceFileTreeDocument {
  readonly documentId: string
  readonly path: string
}

export interface WorkspaceFileTreeProps {
  canvases: readonly WorkspaceFileTreeDocument[]
  onOpen: (canvas: WorkspaceFileTreeDocument) => void
  className?: string
}

interface TreeNode {
  readonly name: string
  readonly path: string
  /** Set when this exact path is a canvas; an intermediate segment that no
   *  canvas claims renders as a plain directory. */
  readonly canvas: WorkspaceFileTreeDocument | null
  readonly children: TreeNode[]
}

// A document path is its full slash-joined placement: splitting on '/'
// reconstructs the tree without a second source of truth.
function buildTree(canvases: readonly WorkspaceFileTreeDocument[]): TreeNode[] {
  interface MutableNode {
    name: string
    path: string
    canvas: WorkspaceFileTreeDocument | null
    children: Map<string, MutableNode>
  }
  const root = new Map<string, MutableNode>()

  for (const canvas of canvases) {
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
}: {
  node: TreeNode
  onOpen: (canvas: WorkspaceFileTreeDocument) => void
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
        {node.canvas ? (
          <button
            type="button"
            onClick={() => node.canvas && onOpen(node.canvas)}
            className="hover:bg-accent hover:text-accent-foreground flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-sm"
          >
            <FileText className="text-muted-foreground size-3.5 shrink-0" />
            <span className="truncate">{node.name}</span>
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
            <TreeItem key={child.path} node={child} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Read-only workspace file tree over document paths. Nesting comes entirely
 * from the paths the /api/v1 canvas list already carries — this component
 * never re-derives or stores tree structure of its own.
 */
export function WorkspaceFileTree({ canvases, onOpen, className }: WorkspaceFileTreeProps) {
  const tree = useMemo(() => buildTree(canvases), [canvases])

  if (tree.length === 0) {
    return (
      <p className={cn('text-muted-foreground text-sm', className)}>
        No canvases in this workspace yet.
      </p>
    )
  }

  return (
    <div role="tree" aria-label="Workspace canvases" className={cn('space-y-0.5', className)}>
      {tree.map((node) => (
        <TreeItem key={node.path} node={node} onOpen={onOpen} />
      ))}
    </div>
  )
}
