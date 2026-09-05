import type { DocumentBacklinksResponse } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { FileText, LayoutDashboard, Waypoints } from 'lucide-react'
import { HEADER_WIDE_TOGGLE_CLASS } from '../../components/ui/header-button.js'
import { cn } from '../../lib/utils.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'

export type ConnectionsBacklink = DocumentBacklinksResponse['backlinks'][number]

export interface ConnectionsChipProps {
  /** `null` while the fetch is in flight or unavailable — the chip waits. */
  readonly backlinks: readonly ConnectionsBacklink[] | null
  /** Whether the inspector slot is showing the connections panel. */
  readonly open: boolean
  readonly onToggle: () => void
}

/**
 * The opener for the "linked from" half of the incentive loop: a link
 * someone writes elsewhere permanently shows up HERE, on the document it
 * points at. Renders beside DocumentProperties in the merged header row;
 * what it opens is `ConnectionsPanel`, in the page's one inspector slot.
 *
 * A zero count still renders. The empty chip is the affordance that says
 * links land somewhere, which is the reason to write one; hiding it until
 * content exists would hide the loop exactly where it needs starting.
 */
export function ConnectionsChip({ backlinks, open, onToggle }: ConnectionsChipProps) {
  const loaded = backlinks !== null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Connections${loaded ? ` (${backlinks.length})` : ''}`}
          aria-expanded={open}
          disabled={!loaded}
          onClick={onToggle}
          className={cn(HEADER_WIDE_TOGGLE_CLASS, 'text-xs tabular-nums')}
        >
          <Waypoints aria-hidden="true" className="size-4" />
          {loaded && backlinks.length}
        </button>
      </TooltipTrigger>
      <TooltipContent>Connections — documents linking here</TooltipContent>
    </Tooltip>
  )
}

export interface ConnectionsPanelProps {
  readonly backlinks: readonly ConnectionsBacklink[]
  /**
   * Sources naming this document in prose without a link — the panel's
   * seeding section. Absent hides it (a backend that answers no mentions).
   */
  readonly mentions?: readonly ConnectionsBacklink[]
  /** The whole entry: the daemon page navigates by `path`, others may not. */
  readonly onOpen: (backlink: ConnectionsBacklink) => void
  /**
   * Converts a mention row's occurrences into real links (the server-side
   * linkify operation). Absent hides the button — a backend without the
   * route offers navigation only.
   */
  readonly onLinkify?: (mention: ConnectionsBacklink) => void
}

/** The documents linking here, and the ones naming this document without a link. */
export function ConnectionsPanel({
  backlinks,
  mentions,
  onOpen,
  onLinkify,
}: ConnectionsPanelProps) {
  return (
    <section aria-label="Connections" className="px-3 py-2">
      <p className="text-muted-foreground mb-1 text-[11px] font-semibold uppercase tracking-wide">
        Linked from {backlinks.length}
      </p>
      {backlinks.length === 0 ? (
        <p className="text-muted-foreground py-2 text-sm">
          No links yet — a [[link]] written in any document lands here.
        </p>
      ) : (
        <SourceList entries={backlinks} onPick={onOpen} />
      )}
      {(mentions?.length ?? 0) > 0 && (
        <>
          <p className="text-muted-foreground mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide">
            Mentioned, not linked {mentions?.length}
          </p>
          <SourceList
            entries={mentions ?? []}
            onPick={onOpen}
            action={
              onLinkify === undefined
                ? undefined
                : { label: 'Link it', onPick: (entry) => onLinkify(entry) }
            }
          />
        </>
      )}
    </section>
  )
}

function SourceList({
  entries,
  onPick,
  action,
}: {
  readonly entries: readonly ConnectionsBacklink[]
  readonly onPick: (entry: ConnectionsBacklink) => void
  readonly action?: { label: string; onPick: (entry: ConnectionsBacklink) => void }
}) {
  return (
    <ul className="flex flex-col">
      {entries.map((entry) => (
        <li key={entry.documentId} className="flex items-start gap-1">
          <button
            type="button"
            onClick={() => onPick(entry)}
            className="hover:bg-muted flex min-w-0 flex-1 flex-col gap-0.5 rounded px-2 py-1.5 text-left"
          >
            <span className="flex items-center gap-1.5 text-sm font-medium">
              {entry.kind === 'spatial' ? (
                <LayoutDashboard aria-hidden="true" className="size-3.5 shrink-0" />
              ) : (
                <FileText aria-hidden="true" className="size-3.5 shrink-0" />
              )}
              {entry.name ?? entry.path}
            </span>
            {entry.contexts.slice(0, 2).map((context) => (
              <span key={context} className="text-muted-foreground truncate text-xs">
                {context}
              </span>
            ))}
          </button>
          {action !== undefined && (
            <button
              type="button"
              onClick={() => action.onPick(entry)}
              className="text-primary hover:bg-accent mt-1.5 shrink-0 rounded border px-2 py-0.5 text-xs font-medium"
            >
              {action.label}
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}
