import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * How long "an agent is editing" stays up after the last announcement.
 *
 * The server sends ONE message per applied batch rather than a begin/end
 * pair, so presence is held here and allowed to lapse. That is what makes an
 * agent that crashes mid-session disappear on its own instead of leaving an
 * indicator a human has to dismiss.
 */
export const AGENT_PRESENCE_MS = 8_000
/** How long the elements an agent touched stay outlined. */
export const AGENT_HIGHLIGHT_MS = 3_000

export interface AgentActivityReport {
  readonly touched: { readonly nodes: readonly string[]; readonly edges: readonly string[] }
  readonly summary: string
}

export interface AgentActivityState {
  /** Whether to show "an agent is editing". */
  readonly active: boolean
  /** The last thing an agent said it did, for the chip's label. */
  readonly summary: string | null
  readonly touchedNodeIds: ReadonlySet<string>
  readonly touchedEdgeIds: ReadonlySet<string>
}

const IDLE: AgentActivityState = {
  active: false,
  summary: null,
  touchedNodeIds: new Set(),
  touchedEdgeIds: new Set(),
}

/**
 * Holds the transient "an agent just did something here" state behind the
 * `agent_activity` WebSocket message.
 *
 * Both timers RESTART on every report rather than accumulating, so a burst of
 * batches reads as one continuous session instead of a flicker, and the
 * highlight always shows the most recent change rather than a union of
 * everything the agent has ever touched.
 */
export function useAgentActivity(): {
  readonly state: AgentActivityState
  readonly report: (activity: AgentActivityReport) => void
} {
  const [state, setState] = useState<AgentActivityState>(IDLE)
  const presenceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    // Unmounting mid-session must not leave a timer that calls setState on a
    // gone component — a document switch is exactly when both are pending.
    return () => {
      clearTimeout(presenceTimer.current)
      clearTimeout(highlightTimer.current)
    }
  }, [])

  const report = useCallback((activity: AgentActivityReport) => {
    setState({
      active: true,
      summary: activity.summary,
      touchedNodeIds: new Set(activity.touched.nodes),
      touchedEdgeIds: new Set(activity.touched.edges),
    })

    clearTimeout(highlightTimer.current)
    highlightTimer.current = setTimeout(() => {
      // Only the highlight clears here. The chip is still up, and dropping
      // `summary` with it would blank the label of a chip that stays visible.
      setState((current) => ({
        ...current,
        touchedNodeIds: new Set(),
        touchedEdgeIds: new Set(),
      }))
    }, AGENT_HIGHLIGHT_MS)

    clearTimeout(presenceTimer.current)
    presenceTimer.current = setTimeout(() => setState(IDLE), AGENT_PRESENCE_MS)
  }, [])

  return { state, report }
}
