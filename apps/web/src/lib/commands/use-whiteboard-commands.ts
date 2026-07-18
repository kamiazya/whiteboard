import { useRef } from 'react'
import { createWhiteboardCommands } from './create-commands.js'
import type { WhiteboardCommandDeps, WhiteboardCommands } from './types.js'

/**
 * React binding for `createWhiteboardCommands`. A page keeps a plain ref of
 * its runtime deps (canvas identity, provider, a getter for the mounted
 * Excalidraw imperative API) updated on every render; the returned
 * `WhiteboardCommands` object itself is created once and stays referentially
 * stable for the lifetime of the component, so a future consumer (e.g. a
 * WebMCP adapter registering `commands.exportJson` at mount time) can safely
 * depend on that identity never changing across re-renders.
 */
export function useWhiteboardCommands(deps: WhiteboardCommandDeps): WhiteboardCommands {
  const depsRef = useRef<WhiteboardCommandDeps>(deps)
  depsRef.current = deps

  const commandsRef = useRef<WhiteboardCommands | null>(null)
  if (commandsRef.current === null) {
    commandsRef.current = createWhiteboardCommands(depsRef)
  }
  return commandsRef.current
}
