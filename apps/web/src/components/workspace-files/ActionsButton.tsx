import { Ellipsis } from 'lucide-react'
import { hasCoarsePointer } from '../../lib/platform.js'
import { cn } from '../../lib/utils.js'

/**
 * The visible way to an object's menu on a touch screen, where right-click
 * does not exist and a long-press leaves no hint that it does.
 *
 * Drawn only on a coarse pointer: with a mouse the menu is one right-click
 * away and the button would be chrome on every card. Never nested in the
 * element it acts on — a button inside a button is invalid — so a host
 * places it beside that element.
 *
 * The anchor handed on is the button's own corner; on a coarse pointer the
 * menu is a bottom sheet and ignores it.
 */
export function ActionsButton({
  name,
  onOpen,
  className,
  reveal = false,
}: {
  /** The object it acts on; the accessible name is "<name> actions". */
  readonly name: string
  readonly onOpen: (x: number, y: number) => void
  readonly className?: string
  /**
   * Also drawn with a fine pointer, shown while its `group/row` is hovered or
   * holds focus: a row with no visible picture of its menu read as having
   * none. Out of the tab order there — the row's own Shift+F10 is the
   * keyboard's way, and a second stop per row would double the Tabs.
   */
  readonly reveal?: boolean
}) {
  const coarse = hasCoarsePointer()
  if (!coarse && !reveal) return null
  return (
    <button
      type="button"
      // Out of the tab order where it is only a picture of the row's menu.
      tabIndex={coarse ? undefined : -1}
      aria-label={`${name} actions`}
      aria-haspopup="menu"
      title={coarse ? undefined : 'Actions (Shift+F10)'}
      onClick={(event) => {
        event.stopPropagation()
        const rect = event.currentTarget.getBoundingClientRect()
        onOpen(rect.left, rect.bottom)
      }}
      className={cn(
        'text-muted-foreground hover:text-foreground hover:bg-accent flex shrink-0 items-center justify-center',
        coarse
          ? 'size-11 rounded-md'
          : 'size-6 rounded opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100',
        className,
      )}
    >
      <Ellipsis aria-hidden="true" className={coarse ? 'size-5' : 'size-4'} />
    </button>
  )
}
