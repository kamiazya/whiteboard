import { referenceMarkup } from '@kamiazya/whiteboard-codec'
import { useMemo, useRef } from 'react'
import type { LinkTarget } from '../../lib/link-target.js'
import { planLinkTarget } from '../../lib/link-target-plan.js'
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
  /** The open document's path, which the Create row must never offer to make. */
  readonly ownPath: string | undefined
  /** Writes the body, so the link the note was made for can be pointed at it. */
  readonly onChange: (next: string) => void
}) {
  const { linkTargetsRef, onOpenDocument, onCreateLinkTarget, ownPath, onChange } = options
  const ownPathRef = useRef(ownPath)
  ownPathRef.current = ownPath
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
  const getOwnPath = useMemo(() => () => ownPathRef.current, [])

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
    if (create === undefined) return {}
    const plan = planLinkTarget(
      found.path,
      ownPathRef.current,
      linkTargetsRef.current.map((target) => target.path),
    )
    if (plan === null) return {}
    return {
      createLinkTarget: {
        path: found.path,
        run: () => {
          // The link keeps the words it was written with (an alias already
          // there wins) and gains the address the note was made at.
          const markup =
            referenceMarkup({ target: plan.path, alias: found.alias ?? plan.name }) ?? plan.markup
          onChange(value.slice(0, found.index) + markup + value.slice(found.index + found.length))
          void Promise.resolve(create(plan.path, plan.name)).catch(() => {})
        },
      },
    }
  }
  return { extension, getCreate, getOwnPath, catalogLinkRows }
}
