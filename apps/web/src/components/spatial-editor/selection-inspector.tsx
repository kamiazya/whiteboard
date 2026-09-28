import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry, type TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { EditorCommand } from '../../lib/spatial/commands.js'
import { collectCanvasTags, retag } from '../../lib/spatial/tags.js'
import { FacetFormPanel, type FacetSubject } from './facet-widgets/FacetFormPanel.js'
import { collectFieldSuggestions } from './facet-widgets/field-suggestions.js'

/**
 * What the inspector is about. An edge selection wins over a node one,
 * because selecting an edge clears the node selection, so the two are never
 * both live. `undefined` when nothing is selected, or what was selected is
 * gone.
 */
export function inspectorSubject(
  canvas: SpatialCanvas,
  selectedId: string | null,
  selectedEdgeId: string | null,
): FacetSubject | undefined {
  const edge =
    selectedEdgeId === null ? undefined : canvas.edges.find((e) => e.id === selectedEdgeId)
  if (edge !== undefined) return { kind: 'edge', edge }
  const node = canvas.nodes.find((n) => n.id === selectedId)
  return node === undefined ? undefined : { kind: 'node', node }
}

/**
 * A write to a MEMBER of the selection applies to the whole set — reshaping
 * five selected nodes must not become five visits to the panel — while a
 * write to a node outside it reaches that node alone.
 */
export function writeReachesIds(
  target: { id: string } | undefined,
  selectedId: string | null,
  extraIds: ReadonlySet<string>,
): string[] {
  if (target === undefined) return []
  const members = new Set(selectedId !== null ? [selectedId, ...extraIds] : [])
  return members.has(target.id) ? [...members] : [target.id]
}

/** One facet written from the panel. An edge selection is one edge; a node write fans out. */
export function facetWriteCommands(
  subject: FacetSubject,
  selectedId: string | null,
  extraIds: ReadonlySet<string>,
  key: string,
  payload: unknown,
): EditorCommand[] {
  if (subject.kind === 'edge') {
    return [{ kind: 'set-edge-facet', id: subject.edge.id, key, payload }]
  }
  return writeReachesIds(subject.node, selectedId, extraIds).map((id) => ({
    kind: 'set-node-facet' as const,
    id,
    key,
    payload,
  }))
}

/**
 * A tag change from the panel, applied as the CHANGE the row showed being
 * made to each object's tags as the eager chain holds them (`current`), never
 * the shown list copied over: under a slow parent the row still shows the
 * list before the previous commit landed, and on a selection of five the
 * four other boxes carry tags of their own.
 */
export function tagWriteCommands(
  current: SpatialCanvas,
  subject: FacetSubject,
  selectedId: string | null,
  extraIds: ReadonlySet<string>,
  after: readonly string[],
): EditorCommand[] {
  if (subject.kind === 'edge') {
    const edge = current.edges.find((e) => e.id === subject.edge.id)
    return [
      {
        kind: 'set-edge-tags',
        id: subject.edge.id,
        tags: retag(edge?.tags, subject.edge.tags ?? [], after),
      },
    ]
  }
  const before = subject.node.tags ?? []
  return writeReachesIds(subject.node, selectedId, extraIds).flatMap((id) => {
    const node = current.nodes.find((entry) => entry.id === id)
    return node === undefined
      ? []
      : [{ kind: 'set-node-tags' as const, id, tags: retag(node.tags, before, after) }]
  })
}

export interface SelectionInspectorProps {
  readonly canvas: SpatialCanvas
  /** The canvas as the eager chain holds it, read at the moment of a write. */
  readonly currentCanvas: () => SpatialCanvas
  readonly selectedId: string | null
  readonly selectedEdgeId: string | null
  readonly extraIds: ReadonlySet<string>
  readonly tagSuggestions: readonly string[] | undefined
  readonly tagLibrary: TagLibrary | undefined
  readonly variant: 'sheet' | 'dock'
  readonly onCommands: (commands: readonly EditorCommand[]) => void
}

/**
 * The facet panel, ABOUT whatever is selected. With nothing selected there
 * is nothing for it to be about, so it closes rather than standing there
 * saying so — the same thing a press on blank canvas does to the context
 * menu.
 */
export function SelectionInspector(props: SelectionInspectorProps) {
  const { canvas, selectedId, extraIds, tagLibrary, onCommands } = props
  const subject = inspectorSubject(canvas, selectedId, props.selectedEdgeId)
  if (subject === undefined) return null
  return (
    <FacetFormPanel
      subject={subject}
      registry={bundledFacetRegistry}
      // What the board already wrote into free-entry fields, so a second
      // classification is a pick. Recomputed per render while the panel is
      // open: one pass over the nodes' facets.
      suggestions={collectFieldSuggestions(canvas.nodes, bundledFacetRegistry)}
      tagSuggestions={[...collectCanvasTags(canvas), ...(props.tagSuggestions ?? [])]}
      {...(tagLibrary === undefined ? {} : { tagLibrary })}
      variant={props.variant}
      onTagsChange={(after) =>
        onCommands(tagWriteCommands(props.currentCanvas(), subject, selectedId, extraIds, after))
      }
      onWrite={(key, payload) =>
        onCommands(facetWriteCommands(subject, selectedId, extraIds, key, payload))
      }
    />
  )
}
