import { isFrame, nodeText, type SpatialNode } from '@kamiazya/whiteboard-model'
import { edgeA11yName, nodeA11yName } from './node-a11y-name.js'

interface HeadingSubject {
  readonly node: SpatialNode | undefined
  readonly edge: Parameters<typeof edgeA11yName>[0] | undefined
  readonly line: object | undefined
  readonly comment: object | undefined
  /** The menu is the open text editor's own catalog. */
  readonly editing: boolean
  readonly nodes: readonly SpatialNode[]
}

/**
 * What a canvas context menu is called, aloud and (on a sheet) on screen.
 *
 * The accessible name says whose actions these are — "Actions for Note:
 * Orders" — rather than naming the surface for every press; a press on
 * empty space keeps the surface's own name.
 */
export function contextMenuHeading(subject: HeadingSubject): { label: string; title: string } {
  if (subject.editing) return { label: 'Text actions', title: 'Text' }
  if (subject.comment !== undefined) return { label: 'Comment actions', title: 'Comment' }
  if (subject.node !== undefined) {
    const name = nodeA11yName(subject.node)
    const title =
      nodeText(subject.node) !== undefined && !isFrame(subject.node) ? `Note: ${name}` : name
    return { label: `Actions for ${title}`, title }
  }
  if (subject.edge !== undefined) {
    const title = edgeA11yName(subject.edge, subject.nodes)
    return { label: `Actions for ${title}`, title }
  }
  if (subject.line !== undefined) return { label: 'Actions for Line', title: 'Line' }
  return { label: 'Canvas actions', title: 'Canvas' }
}
