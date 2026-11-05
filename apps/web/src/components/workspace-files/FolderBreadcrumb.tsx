import { useContext, useEffect, useRef } from 'react'
import { folderTrail } from '../../lib/folder-names.js'
import { ActionsButton } from './ActionsButton.js'
import { FolderActionsContext } from './folder-actions.js'
import { FolderNamesContext } from './use-folder-names.js'
import { useLongPressMenu } from './use-long-press.js'

/**
 * Where the contents pane is, and the way back up.
 *
 * Every segment is a destination, so the trail is navigation and not a
 * label. Only the deepest one is `aria-current`: the rest are ancestors you
 * can still go to, and marking them too would say the pane is showing all
 * of them at once.
 */
export function FolderBreadcrumb({
  folder,
  onSelect,
}: {
  /** The folder being shown. `''` is the workspace root. */
  folder: string
  onSelect: (path: string) => void
}) {
  const segments = folder === '' ? [] : folder.split('/')
  const trail = folderTrail(folder, useContext(FolderNamesContext))
  const longPress = useLongPressMenu(undefined)
  // One row that scrolls rather than wraps: a wrapped trail split a folder's
  // name across two lines and left its menu button floating below. The
  // deepest folder is the one that matters, so the row starts scrolled to it.
  // Names arrive after the folder does, and widen the row, so both re-scroll.
  const row = useRef<HTMLElement | null>(null)
  const shown = trail.join('/')
  useEffect(() => {
    const nav = row.current
    if (nav !== null && shown !== undefined) nav.scrollLeft = nav.scrollWidth
  }, [shown])
  return (
    <nav
      ref={row}
      aria-label="Folder path"
      {...longPress}
      className="mb-1 flex items-center gap-0.5 overflow-x-auto text-xs whitespace-nowrap [scrollbar-width:none]"
    >
      <Crumb label="Workspace" path="" current={folder === ''} onSelect={onSelect} />
      {segments.map((segment, i) => (
        <span
          key={segments.slice(0, i + 1).join('/')}
          className="flex shrink-0 items-center gap-0.5"
        >
          <span className="text-muted-foreground">/</span>
          <Crumb
            label={trail[i] ?? segment}
            path={segments.slice(0, i + 1).join('/')}
            current={i === segments.length - 1}
            onSelect={onSelect}
          />
        </span>
      ))}
    </nav>
  )
}

function Crumb({
  label,
  path,
  current,
  onSelect,
}: {
  label: string
  path: string
  current: boolean
  onSelect: (path: string) => void
}) {
  const actions = useContext(FolderActionsContext)
  return (
    <>
      <button
        type="button"
        data-folder-path={path}
        aria-current={current ? 'true' : undefined}
        onClick={() => onSelect(path)}
        className="hover:text-foreground text-muted-foreground aria-[current]:text-foreground max-w-48 shrink-0 truncate rounded px-1 py-0.5 aria-[current]:font-medium"
      >
        {label}
      </button>
      {actions !== undefined && (
        <ActionsButton name={label} onOpen={(x, y) => actions.openFolderMenu(path, x, y)} />
      )}
    </>
  )
}
