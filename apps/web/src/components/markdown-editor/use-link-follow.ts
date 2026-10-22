import { useMemo, useRef } from 'react'
import type { LinkTarget } from '../../lib/link-target.js'
import type { VerbCatalogHost } from './verb-catalog.js'
import type { LinkTargetCreator } from './wiki-link-completion.js'
import { referenceAtOffset, wikiLinkFollow } from './wiki-link-follow.js'

/**
 * Following and creating `[[links]]` from the source pane: the Ctrl/Cmd+click
 * extension and the catalog rows for the link under the caret.
 *
 * Everything the extension needs is read through refs: it is installed once
 * at view creation, while the target list and the host's handlers are fresh
 * on every render.
 */
export function useLinkFollow(options: {
  readonly linkTargetsRef: { readonly current: readonly LinkTarget[] }
  readonly onOpenDocument: ((documentId: string) => void) | undefined
  readonly onCreateLinkTarget: LinkTargetCreator | undefined
}) {
  const { linkTargetsRef, onOpenDocument, onCreateLinkTarget } = options
  const openRef = useRef(onOpenDocument)
  openRef.current = onOpenDocument
  const createRef = useRef(onCreateLinkTarget)
  createRef.current = onCreateLinkTarget
  const extension = useMemo(
    () =>
      wikiLinkFollow({
        getTargets: () => linkTargetsRef.current,
        getOpen: () => openRef.current,
      }),
    [linkTargetsRef],
  )
  const getCreate = useMemo(() => () => createRef.current, [])

  /** The catalog rows for the reference under `caret` in `value`, if any. */
  const catalogLinkRows = (
    value: string,
    caret: number,
  ): Pick<VerbCatalogHost, 'openLink' | 'createLinkTarget'> => {
    const found = referenceAtOffset(value, caret, linkTargetsRef.current)
    if (found === null) return {}
    if (found.kind === 'resolved') {
      const open = onOpenDocument
      return open === undefined ? {} : { openLink: () => open(found.target.id) }
    }
    const create = onCreateLinkTarget
    return create === undefined
      ? {}
      : { createLinkTarget: { path: found.path, run: () => void create(found.path) } }
  }
  return { extension, getCreate, catalogLinkRows }
}
