/**
 * Where this keeper's bytes live, as a composition root hands it to an
 * adapter. A route that wants a workspace's files directory asks this rather
 * than reading the process's data directory and naming the tenant itself —
 * which is what would otherwise make "which directory, which tenant" a
 * decision taken inside every route.
 *
 * Only the seam lives here, apart from `data-layout.ts` which implements it:
 * an adapter may hold the contract, and may not hold the mechanic that joins
 * the directory names.
 */
export interface DataLayout {
  /** The keeper's data directory: its database, identity and every tenant's bytes. */
  readonly dataDir: string
  /** The tenant these routes serve. */
  readonly tenantId: string
  /** Where a workspace's uploaded files are kept. */
  workspaceFilesDir(workspaceId: string): string
  /** Where a workspace's exports are written by default. Keeper-level, not tenant-scoped. */
  exportsDir(workspaceId: string): string
}
