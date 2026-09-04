import type { DocumentBacklinksResponse } from '@kamiazya/whiteboard-mcp/api-contracts'
import { FileText, LayoutDashboard, Waypoints } from 'lucide-react'
import { useId, useState } from 'react'
import { TOGGLE_STATE_CLASS } from '@/components/ui/dock-button'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip.js'

export type ConnectionsBacklink = DocumentBacklinksResponse['backlinks'][number]

export interface ConnectionsChipProps {
  /** `null` while the fetch is in flight or unavailable — the chip waits. */
  readonly backlinks: readonly ConnectionsBacklink[] | null
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

/**
 * The "linked from" half of the incentive loop: a link someone writes
 * elsewhere permanently shows up HERE, on the document it points at. Renders
 * beside DocumentProperties in the merged header row, and — like its
 * Type/Tags disclosure — overlays below the header instead of growing it.
 *
 * A zero count still renders. The empty chip is the affordance that says
 * links land somewhere, which is the reason to write one; hiding it until
 * content exists would hide the loop exactly where it needs starting.
 */
export function ConnectionsChip({ backlinks, mentions, onOpen, onLinkify }: ConnectionsChipProps) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const loaded = backlinks !== null

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`Connections${loaded ? ` (${backlinks.length})` : ''}`}
            aria-expanded={open}
            aria-controls={panelId}
            disabled={!loaded}
            onClick={() => setOpen((current) => !current)}
            className={cn(
              'text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-1 rounded p-1.5 text-xs tabular-nums disabled:opacity-50',
              TOGGLE_STATE_CLASS,
            )}
          >
            <Waypoints aria-hidden="true" className="size-4" />
            {loaded && backlinks.length}
          </button>
        </TooltipTrigger>
        <TooltipContent>Connections — documents linking here</TooltipContent>
      </Tooltip>
      {open && loaded && (
        <section
          id={panelId}
          aria-label="Connections"
          className="border-border bg-background absolute left-0 right-0 top-full z-20 max-h-80 overflow-y-auto border-b px-3 py-2 shadow-md"
        >
          <p className="text-muted-foreground mb-1 text-[11px] font-semibold uppercase tracking-wide">
            Linked from {backlinks.length}
          </p>
          {backlinks.length === 0 ? (
            <p className="text-muted-foreground py-2 text-sm">
              No links yet — a [[link]] written in any document lands here.
            </p>
          ) : (
            <SourceList
              entries={backlinks}
              onPick={(entry) => {
                setOpen(false)
                onOpen(entry)
              }}
            />
          )}
          {(mentions?.length ?? 0) > 0 && (
            <>
              <p className="text-muted-foreground mb-1 mt-3 text-[11px] font-semibold uppercase tracking-wide">
                Mentioned, not linked {mentions?.length}
              </p>
              <SourceList
                entries={mentions ?? []}
                onPick={(entry) => {
                  setOpen(false)
                  onOpen(entry)
                }}
                action={
                  onLinkify === undefined
                    ? undefined
                    : { label: 'Link it', onPick: (entry) => onLinkify(entry) }
                }
              />
            </>
          )}
        </section>
      )}
    </>
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
