import type { LucideIcon } from 'lucide-react'
import { GitPullRequestArrow, History, Info, MessageSquare, Waypoints } from 'lucide-react'
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
  proposals: GitPullRequestArrow,
  connections: Waypoints,
  history: History,
} as const satisfies Record<InspectorKind, LucideIcon>

/**
 * How each member says its count out loud. The wordings are the ones these
 * controls already carried, so a browser flow finding them by name keeps
 * finding them.
 */
/**
 * Whether this member's count is a BACKLOG — things waiting on a person —
 * rather than a SIZE. The two are said differently ("N open" against
 * "(N)") and drawn differently (a backlog at nought shows nothing, because
 * the opener is holding its place for tomorrow rather than reporting a
 * zero), so the split is named once here.
 *
 * It used to be spelled twice — `kind === 'comments' || kind === 'proposals'`
 * in the name and a bare `kind !== 'comments'` in the badge — and the two
 * disagreed the moment `proposals` arrived: a screen reader heard
 * "Proposals" while the eye saw a `0`.
 */
function countIsBacklog(kind: InspectorKind): boolean {
  return kind === 'comments' || kind === 'proposals'
}

function accessibleName(kind: InspectorKind, count: number | null | undefined): string {
  const label = INSPECTOR_CHROME[kind].label
  if (count === undefined || count === null) return label
  if (countIsBacklog(kind)) return count === 0 ? label : `${label}, ${count} open`
  return `${label} (${count})`
}

export function InspectorSegment({ open, onToggle, tabs }: InspectorSegmentProps): JSX.Element {
  return (
    // biome-ignore lint/a11y/useSemanticElements: <fieldset> groups form controls under a <legend>; these are toggle buttons, and the only role that fits a button cluster, "toolbar", promises roving-tabindex arrow navigation this segment does not implement — declaring it would be an a11y lie.
    <div
      role="group"
      aria-label="Inspect this document"
      data-testid="inspector-segment"
      // Grouped by PROXIMITY, with nothing drawn around it.
      //
      // The outline this used to carry, plus its padding, made the group
      // 50px on a coarse pointer against a 48px row: it crossed the row's
      // top edge and landed on the header's bottom rule, two lines a pixel
      // apart. `inspector-segment-fit.browser.test.tsx` computes that
      // footprint from the fine render, since no test can produce a coarse
      // one.
      //
      // A GROUND instead of the outline was tried and measured worse: the
      // pressed member's `bg-accent` and any `muted` ground come from the
      // same token family, so the ground swallows the one state a toggle
      // has to show. Against the row it is 0.97 on 1.0 (light) and 0.269 on
      // 0.145 (dark); against `bg-muted/50` it is 0.97 on ~0.985 and 0.269
      // on ~0.207 — about half the separation, in both themes.
      //
      // So the group spends no ink at all. What still says these belong
      // together is that they touch (`gap-0.5`) while the divider beside
      // them does not, plus the `role="group"` a reader hears.
      className="flex shrink-0 items-center gap-0.5"
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
                {typeof count === 'number' && (!countIsBacklog(kind) || count > 0) ? count : null}
              </button>
            </TooltipTrigger>
            <TooltipContent>{INSPECTOR_CHROME[kind].label}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
