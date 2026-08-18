/**
 * Transient chip saying an agent is editing this document, and what it just
 * did. Same tier as `PendingCutChip` — it exists only while something is
 * happening — but at the TOP of the canvas, because the bottom is where the
 * dock and the cut chip already live and an agent working while a human
 * holds a cut is exactly when both would collide.
 *
 * It never appears on a document nobody is editing: the state behind it
 * lapses on its own (see `useAgentActivity`), so a crashed agent leaves no
 * indicator for a human to dismiss.
 */
import { Sparkles } from 'lucide-react'

export interface AgentPresenceChipProps {
  /**
   * What the agent last did, e.g. "added 5, tidied the layout". `null` means
   * nothing is happening and the chip does not render at all.
   */
  readonly summary: string | null
}

export function AgentPresenceChip({ summary }: AgentPresenceChipProps) {
  if (summary === null) return null

  return (
    <div
      data-testid="agent-presence-chip"
      data-editor-overlay
      // `status` + polite: an agent editing under you is worth announcing,
      // and at most one announcement per applied batch is not enough traffic
      // to talk over anything. `assertive` would interrupt, which an edit
      // somebody else made does not warrant.
      role="status"
      aria-live="polite"
      className="absolute top-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-sm shadow-lg"
    >
      <Sparkles aria-hidden="true" className="size-3.5 text-muted-foreground" />
      <span>Agent editing — {summary}</span>
    </div>
  )
}
