/**
 * Whether the inspector slot is showing its pane or letting it go.
 *
 * It exists because React unmounts the pane the instant the slot is
 * released, so a leaving animation has nothing to run on — the problem
 * Radix solves with its Presence primitive, which is not a dependency here
 * (only the handful of Radix packages `apps/web/package.json` names).
 *
 * A context rather than a prop because of WHERE the two halves sit: the
 * page decides which pane the slot holds, `DocumentPageShell` renders it,
 * and `InspectorPanel` is the element that has to stay on screen. Passing
 * it down as a prop would mean every pane component forwarded a value it
 * has no use for, and a fifth pane could forget to.
 *
 * `onLeft` is called by the pane when its exit animation ENDS, rather than
 * the shell timing the exit out: the duration is a CSS token and reading it
 * back in JS would make a second producer of it. It also gets
 * `prefers-reduced-motion` right for free — the global block in index.css
 * cuts durations to 0.01ms rather than 0 precisely so `animationend` still
 * fires, so a reader who asked for less motion drops the pane on the next
 * frame instead of watching it sit there for the length of an animation
 * that never played.
 */
import { createContext, useContext } from 'react'

export interface InspectorPresence {
  readonly state: 'open' | 'closed'
  /** The pane, saying it has finished leaving. */
  readonly onLeft: () => void
}

const OPEN: InspectorPresence = { state: 'open', onLeft: () => {} }

export const InspectorPresenceContext = createContext<InspectorPresence>(OPEN)

/** Defaults to `open`, so a pane mounted outside the shell simply shows. */
export function useInspectorPresence(): InspectorPresence {
  return useContext(InspectorPresenceContext)
}
