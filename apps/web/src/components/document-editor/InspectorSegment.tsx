import type { LucideIcon } from 'lucide-react'
import { History, Info, MessageSquare, Waypoints } from 'lucide-react'
import type { JSX } from 'react'
import { INSPECTOR_CHROME, INSPECTOR_ORDER, type InspectorKind } from '../../lib/inspector.js'
import { cn } from '../../lib/utils.js'
import { HEADER_WIDE_TOGGLE_CLASS } from '../ui/header-button.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'

/** What one member shows beside its glyph, when it has anything to show. */
export interface InspectorTabState {
  /**
   * A number the member carries — open conversations, documents linking
   * here. `null` means the answer has not arrived, and the member waits
   * rather than claiming zero.
   */
  readonly count?: number | null
}

export interface InspectorSegmentProps {
  /** Which member the page's one inspector slot is showing, if any. */
  readonly open: InspectorKind | null
  readonly onToggle: (kind: InspectorKind) => void
  /**
   * The members this document offers. A member absent from the map is not
   * drawn: a canvas has no frontmatter, a browser keeper answers no
   * backlinks. Which ones — never their ORDER, which is the segment's.
   */
  readonly tabs: Partial<Record<InspectorKind, InspectorTabState>>
}

/**
 * The four ways to look at the open document, as ONE control.
 *
 * They are already exclusive — `lib/inspector.ts` gives them one state — but
 * exclusive state drawn as four buttons in three different files reads as
 * four unrelated switches, which is what the retune's own screenshots kept
 * showing. Measured at 1280px before this: a canvas row ran
 * `comments, more-actions, history` (the act menu BETWEEN two inspect
 * toggles) and a note ran `properties, comments, more-actions` — the two
 * kinds disagreeing about the order of controls that do the same job.
 *
 * A `group` rather than a `tablist`: these are toggles over a slot that can
 * be empty, and a tablist promises a selected tab at all times.
 */
const GLYPHS = {
  properties: Info,
  comments: MessageSquare,
  connections: Waypoints,
  history: History,
} as const satisfies Record<InspectorKind, LucideIcon>

/**
 * How each member says its count out loud. The wordings are the ones these
 * controls already carried, so a browser flow finding them by name keeps
 * finding them.
 */
function accessibleName(kind: InspectorKind, count: number | null | undefined): string {
  const label = INSPECTOR_CHROME[kind].label
  if (count === undefined || count === null) return label
  if (kind === 'comments') return count === 0 ? label : `${label}, ${count} open`
  return `${label} (${count})`
}

export function InspectorSegment({ open, onToggle, tabs }: InspectorSegmentProps): JSX.Element {
  return (
    <div
      role="group"
      aria-label="Inspect this document"
      data-testid="inspector-segment"
      className="border-border flex shrink-0 items-center gap-0.5 rounded-lg border p-0.5"
    >
      {INSPECTOR_ORDER.filter((kind) => tabs[kind] !== undefined).map((kind) => {
        const { count } = tabs[kind] as InspectorTabState
        const Glyph = GLYPHS[kind]
        // `null` is "not answered yet", which is not the same as 0 and must
        // not be pressable — the panel behind it has nothing to show.
        const pending = count === null
        return (
          <Tooltip key={kind}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={accessibleName(kind, count)}
                aria-pressed={open === kind}
                disabled={pending}
                onClick={() => onToggle(kind)}
                className={cn(HEADER_WIDE_TOGGLE_CLASS, 'text-xs tabular-nums')}
              >
                <Glyph aria-hidden="true" className="size-4" />
                {typeof count === 'number' && (kind !== 'comments' || count > 0) ? count : null}
              </button>
            </TooltipTrigger>
            <TooltipContent>{INSPECTOR_CHROME[kind].label}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
