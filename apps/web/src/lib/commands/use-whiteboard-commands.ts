import { useLayoutEffect, useRef } from 'react'
import { createWhiteboardCommands } from './create-commands.js'
import type { WhiteboardCommandDeps, WhiteboardCommands } from './types.js'

/**
 * React binding for `createWhiteboardCommands`. A page keeps a plain ref of
 * its runtime deps (canvas identity, provider) updated on every render; the
 * returned `WhiteboardCommands` object itself is created once and stays
 * referentially stable for the lifetime of the component, so a future
 * consumer (e.g. a WebMCP adapter registering a command at mount time) can
 * safely depend on that identity never changing across re-renders.
 */
export function useWhiteboardCommands(deps: WhiteboardCommandDeps): WhiteboardCommands {
  const depsRef = useRef<WhiteboardCommandDeps>(deps)
  // Updated at commit time (layout effect), not in the render body:
  // concurrent rendering may pause, abort, or retry a render, and a
  // render-body write could publish deps from a render that never
  // committed. Layout effects run synchronously at commit, before paint —
  // earlier than any user event that could invoke a command.
  useLayoutEffect(() => {
    depsRef.current = deps
  })

  const commandsRef = useRef<WhiteboardCommands | null>(null)
  if (commandsRef.current === null) {
    commandsRef.current = createWhiteboardCommands(depsRef)
  }
  return commandsRef.current
}
