/**
 * What a KEEPER can answer about its workspaces, and what switching to one
 * means for it.
 *
 * Below the shell rather than under the menu that renders it, because this
 * is the seam between a composition root and the chrome: the root builds one
 * per keeper — the browser's over its IndexedDB registry, the daemon's over
 * HTTP — and the shell only asks. A contract filed under its first renderer
 * is a contract the thing that PRODUCES it cannot reach: `hooks/` may not
 * import `components/` (see `layer-order.test.ts`), so the two keepers'
 * answers had to be built inline in `App.tsx` to name the type at all.
 */

import type { RenameWorkspaceInput, WorkspaceEntry } from '@kamiazya/whiteboard-ports'

/**
 * A workspace as the switcher needs it: its identity, plus how much is in it.
 *
 * `documentCount` is optional and absent is NOT zero — zero says the
 * workspace is empty, which is exactly the row a person needs to recognise,
 * while absent says nobody has counted this row YET. Both keepers count, at
 * different moments: the daemon in `list()`, since one HTTP round trip
 * already carries the number; the browser through `counts()` when the
 * popover opens, because its documents live in the workspace tree and
 * reading that means loro-crdt's WASM, which must not load on the shell's
 * render path. So absent is a real and ordinary state — the rows are
 * readable the instant they arrive, and the browser's numbers land a moment
 * later without a spinner or a reflow beyond the number itself.
 */
export type WorkspaceRow = WorkspaceEntry & { readonly documentCount?: number }

/**
 * Where the workspaces come from and how one is made or renamed — the half
 * that differs between the keepers (IndexedDB here, HTTP there).
 *
 * Hold it stable across renders (`useMemo` at the call site, or
 * `hooks/use-shell-workspaces.ts`, which is where both live): the list is
 * read in an effect keyed on this object, so a fresh one per render is a
 * fetch per render.
 */
export interface WorkspaceSwitcherSource {
  list(): Promise<readonly WorkspaceRow[]>
  /**
   * Answers the workspace that was created — including the handle it was
   * actually given.
   *
   * OPTIONAL, because a keeper can genuinely have no way to create one.
   * Absent means the menu offers no creation at all, which is DESIGN.md's
   * standing rule — never offer what the keeper cannot honour — rather than
   * a disabled button, which would say "not right now" about something that
   * is not there. Both keepers publish it today.
   */
  create?(displayName: string): Promise<WorkspaceEntry>
  /**
   * Changes the two layers ADR-0019 lets a workspace's owner choose, and
   * answers the workspace as it now stands. Optional on the same rule as
   * `create`.
   *
   * Takes the canonical `workspaceId`, never the handle — the segment is
   * precisely what may be about to change, and naming the subject by the
   * thing being moved is how a rename addresses the wrong workspace.
   */
  rename?(
    workspaceId: string,
    input: Omit<RenameWorkspaceInput, 'workspaceId'>,
  ): Promise<WorkspaceEntry>
  /**
   * Counts, for a keeper that cannot afford to produce them in `list()`.
   *
   * OPTIONAL, and its absence is not a lesser keeper: the daemon counts in
   * `list()` because one HTTP round trip already carries the number. The
   * browser cannot, because its documents live in the workspace tree and
   * reading that means loading loro-crdt's WASM — 3039.5 KB, behind a
   * control that renders in the app shell. So the browser publishes the
   * count HERE, where it is paid on open rather than on every startup.
   *
   * Measured (CPU x4, 10Mbps/40ms, the LCP rig's profile): 1850 ms over the
   * network, 65 ms out of Cache Storage — and Cache Storage is where this
   * lands on every visit after the first, because the service worker
   * precaches the WASM for offline editing (`check-pwa-precache.mjs` has a
   * guard asserting exactly that). Opening the switcher rides a cost the
   * product already pays; it does not create one.
   */
  counts?(): Promise<ReadonlyMap<string, number>>
}

/** The keeper's half of the switcher, named so a composition root can hold one. */
export interface KeeperWorkspaces {
  readonly source: WorkspaceSwitcherSource
  readonly onSwitch: (handle: string) => void
}
