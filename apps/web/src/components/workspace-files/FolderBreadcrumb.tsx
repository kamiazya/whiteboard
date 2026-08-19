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
  return (
    <nav aria-label="Folder path" className="mb-1 flex flex-wrap items-center gap-0.5 text-xs">
      <Crumb label="Workspace" path="" current={folder === ''} onSelect={onSelect} />
      {segments.map((segment, i) => (
        <span key={segments.slice(0, i + 1).join('/')} className="flex items-center gap-0.5">
          <span className="text-muted-foreground">/</span>
          <Crumb
            label={segment}
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
  return (
    <button
      type="button"
      aria-current={current ? 'true' : undefined}
      onClick={() => onSelect(path)}
      className="hover:text-foreground text-muted-foreground aria-[current]:text-foreground rounded px-1 py-0.5 aria-[current]:font-medium"
    >
      {label}
    </button>
  )
}
