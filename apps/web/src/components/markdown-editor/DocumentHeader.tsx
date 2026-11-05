import type { StoredCoreFacets } from '@kamiazya/whiteboard-model'

export interface DocumentHeaderProps {
  /**
   * The document's name, supplied by the workspace rather than read from
   * `meta` — the stored facets hold no copy of it (ADR-0009 decision 2), and
   * this heading is the same projection `title:` frontmatter serialises to.
   */
  readonly title?: string
  readonly meta: StoredCoreFacets
}

/**
 * The rendered projection of the OKF core facets, shown above the document
 * body in Read mode. Display-only by design: facet EDITING stays in
 * `DocumentProperties` (the header row), which owns the whole-`StoredCoreFacets`
 * emit contract — a second editor here would race it.
 */
/**
 * The OKF types that say nothing a reader does not already know: a page
 * without core facets stands in its kind (`markdown`), and a note made here
 * is typed `note`. An authored type — `decision`, `lesson-plan` — is shown.
 */
const UNREMARKABLE_TYPES: ReadonlySet<string> = new Set(['markdown', 'note'])

export function DocumentHeader({ title, meta }: DocumentHeaderProps) {
  const tags = meta.tags ?? []
  const type = UNREMARKABLE_TYPES.has(meta.type) ? undefined : meta.type
  return (
    <header
      data-testid="markdown-document-header"
      className="border-border mb-8 flex flex-col gap-3 border-b pb-6"
    >
      {title !== undefined && title !== '' && (
        <h2 className="text-foreground text-3xl font-semibold tracking-tight text-balance">
          {title}
        </h2>
      )}
      {(type !== undefined || tags.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          {type !== undefined && (
            <span className="border-border text-muted-foreground rounded-md border px-2 py-0.5 text-xs font-medium">
              Type: {type}
            </span>
          )}
          {tags.map((tag) => (
            <span key={tag} className="text-muted-foreground text-xs">
              #{tag}
            </span>
          ))}
        </div>
      )}
    </header>
  )
}
