import type { FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry, type TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { useSyncExternalStore } from 'react'
import type { EditorCommand, EditorLeafCommand } from '../../lib/spatial/commands.js'
import type { SelectionSource } from '../../lib/spatial/editor-handle.js'
import { collectCanvasTags } from '../../lib/spatial/tags.js'
import { FacetFormPanel } from './facet-widgets/FacetFormPanel.js'
import { collectFieldSuggestions } from './facet-widgets/field-suggestions.js'
import { facetWriteCommands, inspectorSubject, tagWriteCommands } from './selection-inspector.js'

export interface SelectionFacetsSectionProps {
  readonly source: SelectionSource
  readonly canvas: SpatialCanvas
  /** The canvas as the eager chain holds it, read at the moment of a write. */
  readonly currentCanvas: () => SpatialCanvas
  readonly run: (command: EditorCommand) => void
  readonly facetRegistry?: FacetRegistry
  readonly tagSuggestions?: readonly string[]
  readonly tagLibrary?: TagLibrary
}

/**
 * The selection's facets, drawn by the same form and written through the same
 * command builders as the editor's Facets panel (`selection-inspector`), so
 * the Display panel is a second DOORWAY to one writer rather than a second
 * writer. With several nodes selected the form shows the primary one and a
 * write reaches all of them, exactly as the dock panel does.
 */
export function SelectionFacetsSection({
  source,
  canvas,
  currentCanvas,
  run,
  facetRegistry = bundledFacetRegistry,
  tagSuggestions,
  tagLibrary,
}: SelectionFacetsSectionProps) {
  const selection = useSyncExternalStore(
    source.subscribeSelection,
    source.getSelection,
    source.getSelection,
  )
  const subject = inspectorSubject(canvas, selection.selectedId, selection.selectedEdgeId)
  if (subject === undefined) return null
  const extraIds = new Set(selection.extraIds)
  const tagCommands = (after: readonly string[]) =>
    tagWriteCommands(currentCanvas(), subject, selection.selectedId, extraIds, after)
  const facetCommands = (key: string, payload: unknown) =>
    facetWriteCommands(
      currentCanvas(),
      subject,
      selection.selectedId,
      extraIds,
      key,
      payload,
      facetRegistry,
    )
  const count = subject.kind === 'node' ? 1 + selection.extraIds.length : 1
  return (
    <section
      data-testid="selection-facets"
      aria-label="Selection"
      className="flex flex-col gap-2 pb-3"
    >
      <SelectionHeading kind={subject.kind} count={count} />
      <FacetFormPanel
        subject={subject}
        registry={facetRegistry}
        variant="inline"
        suggestions={collectFieldSuggestions(canvas.nodes, facetRegistry)}
        tagSuggestions={[...collectCanvasTags(canvas), ...(tagSuggestions ?? [])]}
        {...(tagLibrary === undefined ? {} : { tagLibrary })}
        onTagsChange={(after) => runAll(tagCommands(after), run)}
        onWrite={(key, payload) => runAll(facetCommands(key, payload), run)}
      />
    </section>
  )
}

const SelectionHeading = ({ kind, count }: { kind: 'node' | 'edge'; count: number }) => (
  <div className="flex items-baseline justify-between">
    <span className="text-xs font-medium">{kind === 'node' ? 'Node' : 'Edge'}</span>
    {count > 1 && <span className="text-xs text-muted-foreground">{count} selected</span>}
  </div>
)

/** One undo step per pick, however many nodes the selection fans it out to. */
const runAll = (commands: readonly EditorCommand[], run: (c: EditorCommand) => void) => {
  const leaves: EditorLeafCommand[] = []
  for (const c of commands) {
    if (c.kind === 'batch') leaves.push(...c.commands)
    else if (isLeaf(c)) leaves.push(c)
  }
  const [only] = leaves
  if (only === undefined) return
  run(leaves.length === 1 ? only : { kind: 'batch', commands: leaves })
}

// A selection write never carries the body, core-facet or proposal commands.
const isLeaf = (c: EditorCommand): c is EditorLeafCommand =>
  c.kind !== 'batch' &&
  c.kind !== 'set-body' &&
  c.kind !== 'set-facets' &&
  c.kind !== 'decide-proposal'
