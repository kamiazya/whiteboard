/**
 * The vessel the comments panel rides in, beside the editor: a column where
 * there is width for one, a bottom sheet over the editor under 768px — the
 * same two shapes the history panel takes, because a 288px column beside a
 * 412px phone screen left the editor a strip a finger could not write in.
 *
 * ONE component for both keeper pages. Each page used to carry its own
 * `<aside>` with the panel inside, and two copies of a vessel drift the way
 * two copies of a reply form did (see ReplyComposer): a shape one page
 * gains, the other lacks.
 */
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { CommentsPanel, type CommentsPanelProps } from './CommentsPanel.js'

export interface CommentsRailProps extends CommentsPanelProps {
  readonly onClose: () => void
}

export function CommentsRail({ onClose, ...panel }: CommentsRailProps) {
  const [expanded, setExpanded] = useState(false)
  return (
    <aside
      aria-label="Comments"
      data-testid="comments-rail"
      data-stage={expanded ? 'full' : 'peek'}
      className={cn(
        'absolute inset-x-0 bottom-0 z-20 flex min-h-0 flex-col border-t bg-background shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.35)]',
        expanded ? 'h-full' : 'h-[45%] rounded-t-2xl',
        'md:static md:z-auto md:h-auto md:w-72 md:max-w-[calc(100vw-1.5rem)] md:shrink-0 md:rounded-none md:border-t-0 md:border-l md:shadow-none',
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-2 pt-1.5 md:pt-2">
        <span className="text-xs font-medium text-muted-foreground md:hidden">Comments</span>
        <button
          type="button"
          data-testid="comments-stage-toggle"
          aria-label={expanded ? 'Collapse comments' : 'Expand comments'}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          // The sheet's grab handle: a wide, shallow target a thumb aims at
          // the edge for, not an icon-sized one.
          className="flex h-6 w-16 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
        >
          {expanded ? (
            <ChevronDown aria-hidden="true" className="size-4" />
          ) : (
            <ChevronUp aria-hidden="true" className="size-4" />
          )}
        </button>
        <button
          type="button"
          aria-label="Close comments"
          onClick={onClose}
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <CommentsPanel {...panel} />
      </div>
    </aside>
  )
}
