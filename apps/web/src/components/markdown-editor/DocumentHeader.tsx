import type { StoredCoreFacets } from '@kamiazya/whiteboard-canvas-model'

export interface DocumentHeaderProps {
  readonly meta: StoredCoreFacets
}

/**
 * The rendered projection of the OKF core facets, shown above the document
 * body in Read mode. Display-only by design: facet EDITING stays in
 * `CanvasProperties` (the header row), which owns the whole-`StoredCoreFacets`
 * emit contract — a second editor here would race it. The title rendered
 * here is the workspace display name's projection, exactly what `title:`
 * frontmatter serialises to.
 */
export function DocumentHeader({ meta }: DocumentHeaderProps) {
  const tags = meta.tags ?? []
  return (
    <header
      data-testid="markdown-document-header"
      className="border-border mb-8 flex flex-col gap-3 border-b pb-6"
    >
      {meta.title !== undefined && meta.title !== '' && (
        <h2 className="text-foreground text-3xl font-semibold tracking-tight text-balance">
          {meta.title}
        </h2>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="border-border text-muted-foreground rounded-md border px-2 py-0.5 text-xs font-medium">
          {meta.type}
        </span>
        {tags.map((tag) => (
          <span key={tag} className="text-muted-foreground text-xs">
            #{tag}
          </span>
        ))}
      </div>
    </header>
  )
}
