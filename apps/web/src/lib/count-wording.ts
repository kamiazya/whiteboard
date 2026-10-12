/**
 * How a count is worded, written once. The carried-plane phrases live here
 * rather than beside the plane reader in `carried-planes.ts` because the
 * cross-origin sender words them too, and that module is statically reachable
 * from the settings page while the plane reader reaches loro and is loaded
 * lazily — so the shared words sit where both can import them for free.
 */

/** "1 box", "0 boxes", "2 boxes". */
export function countOf(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * The trash entries and saved versions a move carried beside its record, as
 * noun phrases for whatever sentence reports on them — a plane that carried
 * nothing is not named at all.
 */
export function planeCounts(carried: { trash: number; versions: number }): string[] {
  return [
    ...(carried.trash === 0
      ? []
      : [countOf(carried.trash, 'trashed document', 'trashed documents')]),
    ...(carried.versions === 0
      ? []
      : [countOf(carried.versions, 'saved version', 'saved versions')]),
  ]
}
