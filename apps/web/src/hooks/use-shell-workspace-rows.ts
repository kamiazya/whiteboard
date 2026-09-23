import type { WorkspaceEntry } from '@kamiazya/whiteboard-ports'
import { useEffect, useState } from 'react'
import { parseWorkspaceRoute } from '../lib/app-routes.js'
import { workspaceHandle, workspaceLabel } from '../lib/workspace-handle.js'
import type { KeeperWorkspaces, WorkspaceRow } from '../lib/workspace-switcher-source.js'

export interface ShellWorkspaceRows {
  /** Every workspace this keeper holds, as the switcher lists them. */
  readonly rows: readonly WorkspaceRow[]
  /** The handle the ADDRESS names, or null where it names no workspace. */
  readonly handleInAddress: string | null
  /** The row that handle resolves to, once the list has landed. */
  readonly activeRow: WorkspaceRow | undefined
  /**
   * What to CALL the current workspace: its label once the row lands, the
   * handle until then — a true statement about where you are, and better
   * than a blank in an accessible name.
   */
  readonly activeName: string | undefined
  /**
   * A rename lands MERGED, not replacing. It answers with a `WorkspaceEntry`
   * — the three identity layers and nothing else — while the row it lands on
   * also carries what the keeper counted. Replacing dropped that count until
   * something else reloaded the list.
   */
  readonly applyRename: (entry: WorkspaceEntry) => void
  /** The counts the menu bought, folded back into the rows that carry them. */
  readonly applyCounts: (counted: ReadonlyMap<string, number>) => void
}

/**
 * The switcher's rows, and everything the ADDRESS says about them.
 *
 * One hook because it is one concern: the list, the handle the URL carries,
 * the row that resolves to, what to call it, and the two ways a row is
 * amended after it has landed. In `AppShell` those were a state, an effect,
 * two stacked derivations and two inline callbacks, with nothing but reading
 * order tying them together.
 *
 * The rows live at the SHELL rather than in the menu, because the popover's
 * head names the current workspace and the head is the shell's. One fetch,
 * two readers — and Radix unmounts the popover's content on close, so
 * holding the counts out here is what makes the second open free. The
 * browser keeper buys them by loading loro-crdt's WASM, and paying that once
 * per session is the whole design.
 */
export function useShellWorkspaceRows(
  workspaces: KeeperWorkspaces | undefined,
  pathname: string,
): ShellWorkspaceRows {
  const [rows, setRows] = useState<readonly WorkspaceRow[]>([])
  const source = workspaces?.source

  useEffect(() => {
    if (source === undefined) return
    let cancelled = false
    source
      .list()
      .then((loaded) => {
        if (!cancelled) setRows(loaded)
      })
      // A list that will not load leaves the mark naming the handle the
      // address carries, which is still true. Failing the whole shell over
      // it would take the settings gear down with it.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [source])

  const handleInAddress = parseWorkspaceRoute(pathname)?.workspace ?? null
  const activeRow =
    handleInAddress === null
      ? undefined
      : rows.find((row) => workspaceHandle(row) === handleInAddress)

  return {
    rows,
    handleInAddress,
    activeRow,
    activeName: nameFor(handleInAddress, activeRow),
    applyRename: (entry) =>
      setRows((current) =>
        current.map((row) => (row.workspaceId === entry.workspaceId ? { ...row, ...entry } : row)),
      ),
    applyCounts: (counted) =>
      setRows((current) =>
        current.map((row) => {
          const count = counted.get(row.workspaceId)
          return count === undefined ? row : { ...row, documentCount: count }
        }),
      ),
  }
}

function nameFor(handleInAddress: string | null, activeRow: WorkspaceRow | undefined) {
  if (handleInAddress === null) return undefined
  return activeRow === undefined ? handleInAddress : workspaceLabel(activeRow)
}
