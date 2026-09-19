/**
 * The workspace's vocabulary as a filter strip ([ADR-0040](../../../../../docs/contributing/adr/0040-scoped-tags.md)
 * decision 6's tags panel): every tag in use, once, the plain ones first and
 * then each scoped key's values under the key — so `health` reads as one
 * axis with its values rather than as `#health:ok` beside `#health:failing`
 * — with a count of what carries it and a title spelling that out.
 *
 * A chip's accessible name is its WHOLE tag (`#health:ok`): that is what the
 * search box shows when it is pressed, and what a screen reader should say;
 * the count is hidden from the name so it stays a name.
 *
 * The one place tag chips are BUTTONS: document rows are buttons already,
 * and a button inside a button is neither valid nor reachable by keyboard.
 */
import type { TagInUse } from '../../lib/files-source.js'

export interface TagStripProps {
  readonly tags: readonly TagInUse[]
  readonly activeTag: string | null
  readonly onToggle: (tag: string) => void
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** What carries the tag, for the chip's title: "2 documents, 1 board". */
export function carriedBy(row: TagInUse): string {
  const parts: string[] = []
  if (row.documents > 0) parts.push(plural(row.documents, 'document', 'documents'))
  if (row.boards > 0) parts.push(plural(row.boards, 'board', 'boards'))
  if (row.nodes > 0) parts.push(plural(row.nodes, 'box', 'boxes'))
  if (row.edges > 0) parts.push(plural(row.edges, 'edge', 'edges'))
  return parts.join(', ')
}

const total = (row: TagInUse) => row.documents + row.boards + row.nodes + row.edges

export function TagStrip({ tags, activeTag, onToggle }: TagStripProps) {
  const plain = tags.filter((row) => row.key === undefined)
  const keys = new Map<string, TagInUse[]>()
  for (const row of tags) {
    if (row.key === undefined) continue
    keys.set(row.key, [...(keys.get(row.key) ?? []), row])
  }
  const chip = (row: TagInUse, label: string) => (
    <button
      key={row.tag}
      type="button"
      aria-pressed={activeTag === row.tag}
      aria-label={`#${row.tag}`}
      title={carriedBy(row)}
      onClick={() => onToggle(row.tag)}
      className="text-muted-foreground hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
    >
      <span>{label}</span>
      <span aria-hidden className="text-muted-foreground/70 tabular-nums">
        {total(row)}
      </span>
    </button>
  )
  return (
    <fieldset
      aria-label="Filter by tag"
      className="flex flex-wrap items-center gap-1 border-0 px-2 pb-1"
    >
      {plain.map((row) => chip(row, `#${row.tag}`))}
      {[...keys].map(([key, rows]) => (
        <span key={key} className="inline-flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground/80 pl-1 text-[11px] font-medium">{key}</span>
          {rows.map((row) => chip(row, row.value ?? row.tag))}
        </span>
      ))}
    </fieldset>
  )
}
