import { ChevronDown, ChevronRight } from 'lucide-react'
import { type ReactNode, useState } from 'react'

function ExpandToggle({
  name,
  expanded,
  onToggle,
}: Readonly<{
  name: string
  expanded: boolean
  onToggle: () => void
}>) {
  return (
    <button
      type="button"
      aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
      onClick={onToggle}
      className="text-muted-foreground hover:text-foreground rounded p-0.5"
    >
      {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
    </button>
  )
}

/**
 * One row of a workspace tree and the expandable group beneath it: the ARIA
 * `treeitem`, its collapse toggle, and the indented `group` of children. The
 * file tree and the folder tree differ only in what sits in the row, so the
 * part that has to agree between them — roles, toggle label — is one
 * component. The toggle carries no test id: a folder has no identity but its
 * path, and a path is content the editor's gesture trace would record.
 */
interface TreeItemShellProps {
  /** Names the item in the toggle's accessible label. */
  name: string
  /** The treeitem's own accessible name. */
  label: string
  hasChildren: boolean
  /**
   * What the row shows beside the toggle. A function receives the group's
   * toggle, for a row that is itself the control that opens and closes it.
   */
  row: ReactNode | ((group: { toggle: () => void; expanded: boolean }) => ReactNode)
  /** The nested items, rendered while expanded. */
  children: ReactNode
}

export function TreeItemShell({
  name,
  label,
  hasChildren,
  row,
  children,
}: Readonly<TreeItemShellProps>) {
  const [expanded, setExpanded] = useState(true)
  const toggle = () => setExpanded((prev) => !prev)

  return (
    // Generic containers carry the ARIA tree roles (APG tree pattern):
    // biome's a11y rules reject interactive roles on semantic ul/li.
    // tabIndex satisfies useFocusableInteractive; actual keyboard operation
    // happens through the nested native buttons, which are tabbable.
    <div
      role="treeitem"
      tabIndex={-1}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-label={label}
    >
      <div className="flex items-center gap-1">
        {hasChildren ? (
          <ExpandToggle name={name} expanded={expanded} onToggle={toggle} />
        ) : (
          <span className="w-[1.125rem]" aria-hidden="true" />
        )}
        {typeof row === 'function' ? row({ toggle, expanded }) : row}
      </div>
      {hasChildren && expanded && (
        // biome-ignore lint/a11y/useSemanticElements: role="group" inside a role="tree" is the APG tree pattern; the suggested semantic elements (fieldset/optgroup) are invalid tree children
        <div role="group" className="border-border/60 ml-3 border-l pl-2">
          {children}
        </div>
      )}
    </div>
  )
}
