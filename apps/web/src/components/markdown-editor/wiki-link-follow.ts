import { EditorView } from '@codemirror/view'
import { scanReferences } from '@kamiazya/whiteboard-codec'
import type { LinkTarget } from '../../lib/link-target.js'

/** What the reference under an offset points at, by the codec's grammar. */
export type ReferenceUnderOffset =
  | { readonly kind: 'resolved'; readonly target: LinkTarget }
  | { readonly kind: 'unresolved'; readonly path: string }

/**
 * The reference whose markup covers `offset`, resolved the way the renderer
 * resolves it: by PATH, or by the opaque id. Never by display name — names
 * are retired from resolution, so `[[Release plan]]` is a dangling link even
 * though a document is called that.
 */
export function referenceAtOffset(
  doc: string,
  offset: number,
  targets: readonly LinkTarget[],
): ReferenceUnderOffset | null {
  const match = scanReferences(doc).find(
    (one) => offset >= one.index && offset <= one.index + one.full.length,
  )
  if (match === undefined) return null
  const target = targets.find((one) => one.path === match.target || one.id === match.target)
  return target === undefined
    ? { kind: 'unresolved', path: match.target }
    : { kind: 'resolved', target }
}

/**
 * Ctrl/Cmd+click on a `[[link]]` in the source opens its document. The
 * modifier keeps a plain click what it always was — placing the caret — and
 * `preventDefault` stops CodeMirror from also adding a second cursor there.
 */
export function wikiLinkFollow(host: {
  readonly getTargets: () => readonly LinkTarget[]
  readonly getOpen: () => ((documentId: string) => void) | undefined
}) {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false
      const open = host.getOpen()
      if (open === undefined) return false
      const offset = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (offset === null) return false
      const found = referenceAtOffset(view.state.doc.toString(), offset, host.getTargets())
      if (found?.kind !== 'resolved') return false
      event.preventDefault()
      open(found.target.id)
      return true
    },
  })
}
