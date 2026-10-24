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
}: {
  /** The object it acts on; the accessible name is "<name> actions". */
  readonly name: string
  readonly onOpen: (x: number, y: number) => void
  readonly className?: string
}) {
  if (!hasCoarsePointer()) return null
  return (
    <button
      type="button"
      aria-label={`${name} actions`}
      aria-haspopup="menu"
      onClick={(event) => {
        event.stopPropagation()
        const rect = event.currentTarget.getBoundingClientRect()
        onOpen(rect.left, rect.bottom)
      }}
      className={cn(
        'text-muted-foreground hover:text-foreground hover:bg-accent flex size-11 shrink-0 items-center justify-center rounded-md',
        className,
      )}
    >
      <Ellipsis aria-hidden="true" className="size-5" />
    </button>
  )
}
